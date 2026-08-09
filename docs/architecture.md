# PocketTUI 完整设计

状态：实现基线（Draft 1）  
日期：2026-08-09  
目标：构建一个以长期低内存、稳定低延迟和终端原生优化为核心，能够替代 OpenTUI/Pi 类渲染内核的 TUI 框架。

## 1. 结论

PocketTUI 不采用“JS 每帧构造 UI 树 → native 绘制完整 framebuffer → 全屏 diff”的架构。它采用四层分离：

1. **JS/TS 控制层**：声明组件、业务状态和事件，只提交语义事务，不参与逐帧布局、逐 cell 绘制或终端序列生成。
2. **Rust Runtime**：单 owner 持有活跃场景、虚拟文档、布局、命中测试、焦点、选择和调度状态。
3. **增量视觉内核**：只处理被语义 mutation 影响的 measure/layout/paint/hit/semantics 阶段，只物化 viewport 附近内容。
4. **Terminal Transition Engine**：把终端当作远端、有状态、能力不统一的协处理器，从“已确认物理状态”规划到“目标状态”的最低代价、可恢复终端程序。

总原则是：

```text
每次更新工作量 ≈ 语义变化量 + viewport 物化量 + 实际 damage + 实际输出字节
```

不得退化为：

```text
活跃树大小 + 历史长度 + 整屏 cell 数 + 累计流式文本长度
```

渲染、runtime、GC、memory 和 I/O 背压是同一个设计问题，不能分别补丁式优化。

## 2. 产品边界

### 2.1 v1 必须支持

- Node.js 与 Bun；Rust native runtime 通过 N-API 加载。
- TypeScript/JavaScript、编译 JSX、signals，以及同一内核上的 imperative API。
- `Box`、`Text`、`RichText`、`Row`、`Column`、`Grid`、`Stack`、`ScrollView`、`VirtualList`、`VirtualTranscript`、`TextInput`、`Overlay`、`Image`。
- alternate-screen 全屏交互、main-screen 原生 scrollback、CLI/direct 三种 surface。
- Unicode extended grapheme cluster、宽字符、组合字符、双向选择边界、OSC 8 link。
- Kitty keyboard、legacy keyboard、bracketed paste、focus、mouse、IME cursor marker。
- CSI synchronized update；Kitty graphics 为主、Sixel/文本 fallback 可选。
- 结构化 terminal capability 探测、resize、suspend/resume、恢复终端状态。
- 长会话、流式 Markdown、工具输出、图片和慢 TTY 下的有界内存。

### 2.2 明确不做

- 不实现浏览器 DOM、完整 CSS cascade、通用 selector engine 或 React reconciliation。
- 不把 JS object、字符串行数组或 ANSI 字符串作为 native renderer 的核心 IR。
- 不保证 main-screen 与 alternate-screen 具有完全相同的随机访问能力。
- 不在 v1 建造 GPU/pixel scene graph、透明 alpha plane 系统或通用动画引擎。
- 不允许无限队列、无限 cache、无限 paste buffer 或无限 mutation log。
- 不以 QuickJS 替换 Node/Bun 来制造不公平 benchmark；standalone QuickJS host 是后续部署形态。
- OpenTUI 兼容层是迁移工具，不是内部架构。

## 3. 总体架构

```text
Application state
      │
      ├── compiled JSX slots / signals
      └── imperative handles
                    │ packed semantic transactions
                    ▼
┌──────────────────────── JS boundary ────────────────────────┐
│ staging map · event handler registry · bounded commit queue │
└────────────────────────────┬─────────────────────────────────┘
                             ▼
┌──────────────────── Rust single-owner runtime ──────────────┐
│ SceneDB       DocumentDB       Input/Focus       Scheduler  │
│ active UI     open/sealed      native islands    priorities │
└──────────┬─────────────┬───────────────┬─────────────────────┘
           ▼             ▼               ▼
      typed dirty    sliver viewport  background parse
           └─────────────┬───────────────┘
                         ▼
             layout · paint artifacts · damage
                         ▼
┌────────────── Terminal Transition Engine ───────────────────┐
│ desired + semantic scroll + confirmed terminal state       │
│ → capability-aware, cost-planned PatchPlan                 │
└────────────────────────────┬─────────────────────────────────┘
                             ▼
                  nonblocking transactional writer
                             ▼
                          Terminal
```

Native runtime 默认只有一个模型 owner 线程。输入读取、输出 readiness 和 runtime 命令通过同一 reactor 驱动；Markdown/highlight 等纯计算工作可交给一个有界 worker pool。worker 不能直接修改 SceneDB/DocumentDB，只能返回带 generation 的不可变结果。

## 4. 公共 API

### 4.1 创建与生命周期

```ts
import {
  createTui,
  signal,
  batch,
  type TuiApp,
} from "@pocket-tui/core";

const app = await createTui({
  surface: "alternate",          // "alternate" | "main" | "direct"
  input: process.stdin,
  output: process.stdout,
  profile: "compact",            // "compact" | "balanced" | "rich"
  framePolicy: "adaptive",
  capabilities: "probe",
  spill: { mode: "provider" },
});

app.mount(<Root />);
await app.ready;

// 显式关闭是正确性语义；GC finalizer 只作最后保险。
await app.close({ drain: true, timeoutMs: 500 });
```

生命周期状态固定为：

```text
created → probing → active ↔ suspended → draining → closed
                       └──────────────→ failed
```

`close()` 幂等。`failed` 会恢复 raw mode、鼠标、paste、cursor、alternate screen 等已启用终端模式，并使所有 native handle 失效。

三种 flush 语义不可混用：

```ts
await app.flush("accepted"); // 事务已应用到 SceneDB/DocumentDB
await app.flush("painted");  // 对应 desired generation 已生成
await app.flush("terminal"); // patch 已完整写入并提交 confirmed state
```

### 4.2 JSX 是一次实例化模板，不是每帧 VDOM

```tsx
const query = signal("");
const busy = signal(false);

function Root() {
  return (
    <Column width="100%" height="100%">
      <VirtualTranscript
        flex={1}
        source={conversationSource}
        followTail
        overscanRows={12}
      />
      <Row border="top">
        <TextInput
          value={query}
          disabled={busy}
          onSubmit={(text) => send(text)}
        />
        <Text text={() => busy() ? " working" : ""} tone="muted" />
      </Row>
    </Column>
  );
}
```

编译器把静态结构变成 template，把动态表达式变成 slot。`busy()` 改变时只提交对应 slot 的 `SetProp`；不会重新执行 Root、重建子树或扫描无关节点。

结构控制只提供有稳定 identity 的形式：

```tsx
<Show when={detailsVisible} keepAlive="budgeted">
  <Details />
</Show>

<For each={rows} key={(row) => row.id}>
  {(row) => <RowView row={row} />}
</For>
```

没有 key 的动态列表在开发模式报错；生产模式不进行按位置猜测复用。

### 4.3 Imperative API 与 JSX 共用同一事务层

```ts
const log = app.createTranscript({ followTail: true });

const block = log.openBlock({ kind: "assistant", id: messageId });
block.appendUtf8(chunk);
block.setMetadata({ streaming: true });
block.seal();

const input = app.ref<TextInputHandle>("prompt");
input.insertText("hello");
input.focus();
```

高频操作必须有语义专用 opcode：`AppendText` 不得被降级为 `SetText(old + chunk)`，`ScrollBy` 不得被降级为重新设置所有可见行。

### 4.4 自定义组件

JS 自定义组件是 template/slot 组合，不接收 frame callback。v1 的扩展点有三类：

1. 组合内建 primitive；
2. 实现 `VirtualDataSource`，按稳定 ID/范围提供数据；
3. 注册 native plugin primitive，声明 measure/layout/paint/hit contract 与 memory budget。

任何 plugin 都必须提供 full-render oracle 路径，并声明是否是 layout/paint boundary。

Document block 使用单独的 compile-time template；历史 block 进入 viewport 时不能调用 JS：

```tsx
const AssistantBlock = defineBlockTemplate(
  "assistant",
  {
    body: fields.markdown(),
    streaming: fields.boolean(),
  },
  (field) => (
    <Box paddingX={1}>
      <Markdown source={field.body} streaming={field.streaming} />
      <Show when={field.streaming}><Text text=" ▌" /></Show>
    </Box>
  ),
);
```

编译器把它变成 native block template；DocumentDB field 直接绑定 typed slot。template 函数只在构建时执行，不在 materialize、scroll 或 frame 时执行。

## 5. 编译结果与跨语言事务

### 5.1 Template

每个编译单元生成：

- 静态 node template；
- node/slot 的局部编号；
- slot 类型与 dirty effect；
- 事件 handler ID；
- source map；
- 可选 fast-path，例如纯 Text slot 的 `SetText`。

示意：

```ts
const template = defineTemplate({
  nodes: [
    [Op.Node, Kind.Column, 0],
    [Op.Node, Kind.TextInput, 1],
    [Op.Node, Kind.Text, 1],
  ],
  slots: [
    [Slot.Text, 2, Dirty.Measure | Dirty.Paint],
    [Slot.Disabled, 1, Dirty.Paint | Dirty.Hit],
  ],
});
```

### 5.2 Packed transaction ABI

ABI 基于稳定 Node-API（最低 N-API v8）和 versioned little-endian binary protocol；禁止 JSON、Rust `repr(Rust)`、native pointer/slice/allocator buffer 进入边界。每个 batch 有固定 header：

```text
"PTUI" | abi_major/minor | feature_bits | total_bytes
       | sequence:u64 | op_count | checksum(debug)
```

record 以 8-byte 对齐：`opcode:u16 | flags:u16 | record_bytes:u32 | payload`。decoder 在修改任何模型状态之前完成 total length、offset/add overflow、UTF-8、handle、record overlap、unknown mandatory opcode、generation monotonicity 和 memory reservation 校验；失败原子拒绝整批。单 packet 默认最大 8 MiB。

核心 opcode：

| 类别 | Opcode |
|---|---|
| 结构 | `CreateTemplate`, `InsertNode`, `MoveNode`, `RemoveNode` |
| 属性 | `SetScalar`, `SetStyleId`, `SetText`, `SetHandler` |
| 文档 | `OpenBlock`, `AppendUtf8`, `EditOpenRange`, `SealBlock`, `ReplaceBlock`, `EvictBlock` |
| 交互 | `Focus`, `SetSelection`, `ScrollBy`, `ScrollTo`, `CaptureMouse` |
| 资源 | `RegisterBlob`, `PlaceImage`, `ReleaseBlob` |
| 生命周期 | `Commit`, `Suspend`, `Resume`, `Close` |

同一个 JS turn 内，普通 slot write 在 staging map 中按 `(handle, slot)` last-write-wins；结构变更、document append、用户 action 和资源生命周期保持顺序且不可丢弃。

内部 binding 保持极小：`open`、`submit(packet)`、`drainEvents(dst)`、`memoryStats`、`close`。初始 N-API 传输使用两个可复用 packet slot：小事务同步借用 `Uint8Array` 并一次复制/解码，大文本/图片通过独立 blob page 注册。native 不持有 JS heap 指针；数据在导出调用返回前被复制或转移到 Rust-owned storage。后续可以加入 SharedArrayBuffer ring，但它不是 v1 正确性的前提。

### 5.3 JS→Rust 背压

跨边界队列按字节而不是消息数限额。`commit()` 返回：

```ts
type CommitResult =
  | { accepted: true; sequence: bigint }
  | { accepted: false; writable: Promise<void> };
```

slot state 可留在 JS staging map 中继续合并；ordered op 不能越过未接受的 ordered op。`flush("accepted")`、`flush("painted")`、`flush("terminal")` 分别表示 native model 已应用、desired generation 已生成、以及对应 patch 已完整交给 OS stream。

## 6. Rust Runtime 与并发模型

### 6.1 单 owner

SceneDB、DocumentDB、layout state、paint cache、focus、selection、terminal model 只由 runtime thread 修改。热路径不使用全局锁；handle 解析后直接访问 SoA arena。

其他线程：

- **JS event loop**：业务状态、事件 callback、事务 staging；
- **worker pool**：Markdown parse、syntax highlight、压缩和索引；固定上限，默认 `min(2, max(1, cores - 1))`；
- **可选 provider I/O**：加载已 evict 的 document block/blob。

worker 输入和输出均不可变，携带 `(object_handle, generation, task_kind)`。generation 不匹配的完成结果直接丢弃；相同对象同类任务最多一个 in-flight 和一个 latest request。

### 6.2 Runtime loop

```text
1. drain terminal input / output readiness
2. apply urgent native interaction
3. apply bounded model transactions
4. accept valid worker results
5. run due measure/layout/paint
6. build or advance PatchPlan
7. dispatch typed events to JS
8. use remaining budget for background work
```

每轮都有时间和条目预算，避免 paste、streaming 或 worker result 永久饿死 input。无事件、无 dirty、无 pending output 时 reactor 休眠，零 fixed tick。

### 6.3 Native interaction islands

光标移动、selection drag、scroll offset、TextInput 编辑/undo、mouse hover 等可在 native 立即更新并绘制，然后异步发结构化事件给 JS。JS 可以接受、校正或回滚，但 JS 卡顿不能阻塞按键回显。

只有被显式声明为 `nativeControlled` 的状态允许这样工作。业务 action（提交命令、发请求、删除数据）永远进入 JS，不由 native 猜测执行。

## 7. SceneDB

### 7.1 Handle 与存储

公开 handle 是 64 bit，在 JS 中表示为 `bigint`：

```text
kind:8 | runtime_tag:16 | generation:16 | slot:24
```

`0` 无效；每次释放 slot 时 generation 增加，generation 即将 wrap 的 slot 永久 quarantine。每次访问验证 kind、runtime tag、slot bounds、generation 和 lifecycle state；stale/cross-runtime/type-confused handle 返回结构化 `StaleHandleError`，不能命中复用后的对象。

Node 采用 SoA：

```text
kind[] parent[] first_child[] next_sibling[] flags[]
style_id[] layout_id[] paint_id[] hit_id[] semantics_id[]
dirty_mask[] dirty_reason[] queued_epoch[]
```

对象头不持有 JS object、closure 或独立 heap allocation。事件只保存 `handler_id: u32`，callback 留在 JS registry。

### 7.2 Typed dirtiness

```rust
bitflags! {
  struct Dirty: u8 {
    const MEASURE   = 1 << 0;
    const LAYOUT    = 1 << 1;
    const PAINT     = 1 << 2;
    const HIT       = 1 << 3;
    const SEMANTICS = 1 << 4;
  }
}
```

mutation 发生时立即加入对应 phase queue，并以 epoch 去重。每个 dirty 带 reason bits，例如 `TEXT_CHANGED`、`STYLE_GEOMETRY`、`SCROLL_OFFSET`、`CHILD_INSERTED`、`WIDTH_MODE_CHANGED`。

传播规则固定：

- intrinsic size 变化向上走到最近 layout boundary；
- geometry 变化使旧、新 paint bounds 同时 damage；
- 纯颜色变化不触发 measure/layout；
- scroll offset 只触发 viewport geometry、paint/hit，并产生 semantic scroll record；
- terminal capability/theme/Unicode width mode 变化按依赖范围失效，必要时整屏失效。

boundary 是正确性 contract，不是任意 cache hint。debug 模式定期用 root rebuild 比较结果。

### 7.3 节点生命周期

```text
Allocated → Attached → Active → Detached → Retired → Reclaimed
```

`Detached` 节点只有在 keep-alive budget 内才保留 layout/local state。`Retired` 等待所有 in-flight immutable snapshot 释放后才回到 freelist。JS wrapper finalizer 只提交 `ReleaseHandle`；显式 `RemoveNode` 才决定 UI 语义。

## 8. DocumentDB

SceneDB 只保存可交互活跃结构；聊天记录、日志和大列表属于 DocumentDB。封口历史不得继续拥有 JS component、signal subscriber 或 render node。

### 8.1 Block 状态

```text
Open → SealedHot → SealedCompressed → Evicted
  └──────────────→ Replaced(by new stable version)
```

- `Open`：允许 append 和有界 tail edit；增量 parser 只处理未封口尾部。
- `SealedHot`：内容不可变，保留紧凑 UTF-8、span 和各 width generation 的高度摘要。
- `SealedCompressed`：冷 block 按 chunk 压缩；只有可见时解压。
- `Evicted`：runtime 只保留稳定 ID、metadata、height summary 和 provider token；内容按需从 datasource 恢复。

sealed block 不允许原地编辑。修改历史会生成新 version 并原子替换 ID 映射，旧 version 在 snapshot 释放后回收。

### 8.2 Height index 与 viewport

block 顺序和高度使用带 prefix-sum 的 B+ tree（实现可先采用页式 Fenwick tree）。查询：

- offset → 首个 block：`O(log N)`；
- materialize visible+overscan：`O(log N + K)`；
- 单 block 高度修正：`O(log N)`；
- append tail：摊销 `O(1)`，页 split `O(log N)`。

高度 cache key：

```text
(block_version, width, theme_geometry_id, unicode_width_mode, parser_version)
```

width 变化时不扫描全部历史。只使旧 generation 的高度成为 estimate；从 viewport anchor 向外按需重算。anchor 使用 `(stable_block_id, intra_block_grapheme, visual_y)`，避免可见内容跳动。

### 8.3 Virtual data source

```ts
interface VirtualDataSource<T> {
  getCount(): number | bigint;
  getId(index: number | bigint): string | bigint;
  load(range: { start: bigint; end: bigint }, signal: AbortSignal): Promise<T[]>;
  estimateHeight?(id: string | bigint, width: number): number;
  release?(ids: readonly (string | bigint)[]): void;
}
```

同时最多存在：visible、overscan、focus/selection pin、以及按字节限制的 keep-alive。search/copy/offscreen focus 通过 DocumentDB 索引定位，仅临时 materialize 目标窗口，不实例化中间历史。

### 8.4 Streaming Markdown

每个消息由 immutable sealed prefix 和一个 open tail 组成：

```text
[sealed block 0][sealed block 1] ... [open tail]
```

parser 保存 block-boundary continuation state。append 只重词法/解析 open tail 的最小不稳定区；闭合段落、fence 或列表后立即 seal。syntax highlight 只对 visible code range 调度，任务可取消、single-flight、latest-wins。Mermaid/昂贵 transformer 默认仅在 block seal 或显式展开后运行。

streaming preview 保证 append-stable，而不是保证每个中间 byte 都与最终 CommonMark 完全相同。可能反向改变解释的 construct（例如 reference definition）保存索引并延迟最终解析；`seal()` 冻结 bytes、解析剩余 construct、解析引用并产生精确最终语义。finalization 可以与尚未解析的 construct 数成比例，但不能重新 lex 已提交 prefix。parser depth、delimiter 和 pending-construct memory 都有上限；对抗性输入安全降级为 literal text 并产生可恢复诊断。

不得在每个 token chunk 上重新构造 Markdown component、重新 parse 累计全文或 join 累计 bash output。

## 9. Layout 与真正的虚拟化

### 9.1 Box layout

所有几何使用 terminal cell 整数坐标。v1 支持：

- fixed/min/max/content/fr/percent；
- row/column flex、gap、padding、border、alignment；
- bounded grid；
- absolute/overlay；
- clip、scroll、sticky tail。

常见 `Row`/`Column` 使用专用单遍 solver；只有声明了 flex shrink/grow 或 grid constraint 的局部子树进入通用 solver。layout node 持久存在，不在每帧重建。

约束：

```rust
struct BoxConstraints {
    min_w: u16,
    max_w: u16,
    min_h: u16,
    max_h: u16,
}
```

每个 layout boundary 缓存 `(constraints, child_geometry_epoch) -> geometry`。完全一致的 key 直接复用；不是通过“可能没变”的启发式跳过。

### 9.2 Sliver protocol

大列表不能先 layout 全文再 clip。`VirtualList`/`VirtualTranscript` 使用独立协议：

```rust
struct ViewportConstraints {
    scroll_offset: i64,
    viewport_extent: u32,
    cross_extent: u16,
    overscan_before: u16,
    overscan_after: u16,
    anchor: Anchor,
}

struct ViewportGeometry {
    first_id: BlockId,
    last_id: BlockId,
    leading_extent: i64,
    content_extent_estimate: i64,
    exposed_before: u16,
    exposed_after: u16,
}
```

滚动一行的正常路径：更新 offset → B+ height index 定位 → 保留仍可见 block → 只 materialize 新暴露 strip → 发 semantic scroll record。不得遍历不可见 block 或整棵 active tree。

### 9.3 Reflow

resize 时：

1. 立即锁定 anchor；
2. 取消旧 width generation 的未开始 parse/layout 任务；
3. 只重排 viewport+overscan；
4. 用 estimate 更新远端总高度；
5. 后台仅在需要时填充邻近 height cache；
6. 每次真实高度修正都相对 anchor 补偿 scroll offset。

## 10. Paint artifact 与 damage

### 10.1 Terminal-independent cell

最终 canonical screen 是一个 dense viewport，但 cell 不持有 heap string：

```rust
struct Cell {
    grapheme_id: u32,
    style_id: u32,
    aux_id: u32,      // link/image/semantic payload
    flags: u16,
    width: u8,        // 1/2 for lead, 0 for continuation
    layer: u8,
}
```

`Cell` 必须通过 compile-time assertion 保持 16 bytes、pointer-free；steady-state compare 不解引用 heap。

常见 ASCII grapheme 可 inline 到专用 ID 区；短 EGC inline packed，长 EGC 才进入 interner。style/link/image 用 compact generational ID。

宽字素不变量：每个 cell 要么是 lead，要么是指向 lead 的 continuation。任何 overwrite、clip、diff、scroll 和 dirty span 边界都扩张到旧、新 grapheme 的完整所有权范围。

### 10.2 Persistent paint fragment

每个 paint boundary 可缓存 terminal-independent row spans，而不是 ANSI。cache key 包含 geometry、paint epoch、theme 和 width mode。clean fragment 可被 confirmed/in-flight/latest generation 共享；dirty row 才 copy-on-write。

### 10.3 Damage ledger

每行保存：

```text
dirty bit | min_x | max_x | reason bits | old_bounds | new_bounds
```

另有 semantic records：

```text
ScrollRegion { top, bottom, delta }
ImageMove { placement_id, old_rect, new_rect }
CursorOnly { old, new }
```

normal commit 目标为 `O(D_rows × affected_spans + emitted_bytes)`。damage 超过阈值时自适应升级为 full-row 或 full-frame；阈值由编码成本估算，不只看 operation 数量。

## 11. Terminal Transition Engine

这是 PocketTUI 的一等核心层，而不是 framebuffer backend。

### 11.1 输入和状态

planner 输入：

- immutable desired rows；
- damage ledger 与 semantic records；
- `ConfirmedTerminalState`；
- capability/profile；
- surface policy；
- writer byte budget。

damage/semantic-scroll 是优化证据，不是唯一真相。planner 至少扫描 viewport 的 immutable row handles：同一 row page 直接判等，不同 handle 才比较 hash/cells 并补全遗漏 damage；错误的 damage ledger 不能隐藏真实变化。

`ConfirmedTerminalState` 包含：

```text
row handles/cells
cursor position and visibility
active SGR / hyperlink
wrap and margin state
enabled terminal modes
image content IDs and placement IDs
output generation
```

这里的 confirmed 表示相应字节已完整交给 OS output stream；终端协议通常没有“已经显示”的 ACK。partial write 期间状态仍属于 in-flight，不能作为下一次 diff 基线。

### 11.2 规划顺序

```text
1. validate capability/surface generation
2. consume safe semantic scroll/image operations
3. rotate logical confirmed row handles for accepted scroll
4. expand grapheme/image/link damage boundaries
5. identify changed row spans
6. generate candidate terminal programs
7. choose lowest weighted cost
8. wrap in synchronized-update transaction when supported
9. produce immutable PatchPlan
```

候选包括：

- overwrite changed run；
- common prefix/suffix + `EL`/`ECH`；
- `ICH`/`DCH`；
- repeated character sequence；
- absolute `CUP` 与 relative `CUU/CUD/CUF/CUB/CR/LF`；
- `SU/SD/IL/DL` 与 scroll region；
- stateful SGR/link elision；
- image placement update without content retransmit。

成本函数：

```text
cost = encoded_bytes
     + parser_weight(profile, opcode)
     + cursor_risk
     + wrap/margin_risk
     + quirk_penalty
```

v1 在每个 changed row 内做 width-8 bounded beam search，在 row 之间用 profile-aware cursor routing，并永远保留 safe full-row/full-frame candidate。默认分数：

```text
encoded_bytes + 2×escape_count + ceil(display_cells_written/4) + quirk_penalty
```

标准 200×60 viewport 的 incremental planning budget 默认 250 µs、4096 candidates；超出立即采用已验证 fallback 并记录 reason。`REP`、`ICH`、`DCH` 在 v1 默认禁用，只有 positively verified terminal profile 才加入 candidate。`EL/ECH` 也只在 BCE/blank-style 语义已知时使用，否则写 literal spaces。

选中 plan 后用 production state simulator 验证其 grid/cursor/style/link/image observable state 等于 desired，再交给 writer。任何 correctness 条件不明确的指令成本为无穷；不会为了少几个字节冒险。

### 11.3 Semantic scroll

当 viewport 在同一内容 generation 上滚动 `k` 行时：

- 先验证 region、overlay、wide EGC、image、margin、terminal capability；
- 旋转 row handles，而不是复制 `W×H` cells；
- alternate screen 优先 `SU/SD` 或 scroll-region；
- main screen 只使用不会破坏 scrollback 的前向操作；
- 只 paint 新暴露的 `|k|` 行和被 overlay/image 影响的 region。

v1 只接受 full-width、完全位于 alternate viewport、没有 image 相交的 scroll region；`source_generation` 必须等于 confirmed，preserved row 必须按 identity，或 hash 后 full equality，对应 desired target。planner 同时比较 `scroll-op + exposed rows` 与普通 row diff 的真实成本。

不安全时回退到 row damage；永不让 semantic-scroll fast path 成为正确性前提。

### 11.4 Image state

图片分为两个 cache：

1. `ImageContent`: content hash → terminal transmission ID；
2. `ImagePlacement`: placement ID → content ID + rect + z + clipping。

滚动、遮挡或 resize 通常只更新 placement。Kitty payload 以约 4 KiB chunk 惰性编码；Sixel 被视为会破坏矩形区域的 paint op。清理只删除 stale placement/content，不做“文本 frame 一来就清空全部图片”。

默认单图限制：encoded ≤32 MiB、任一边 ≤8192 px、总像素 ≤16,777,216、decoded RGBA ≤64 MiB；header/dimension/decompression-ratio validation 在像素分配前完成。更严格的 compact profile 可以降低这些值，但不能提高全局 image pool hard cap。

## 12. 三种 Surface

### 12.1 `alternate`：主性能契约

- 进入 alternate screen；
- 允许随机 cursor addressing；
- 支持完整 overlay、mouse、image、selection；
- 启用 synchronized update；
- resize 后可 full repaint；
- 所有 benchmark 的完整功能基线。

### 12.2 `main`：原生 scrollback

- 不清 terminal scrollback；
- 只在一个有界 tail window 内做 in-place 更新；
- sealed 且越过 tail window 的行以前向 `CR/LF` 提交给 terminal history，然后从物理模型释放；
- cursor route 只前进，不随意 home、回到已提交历史或覆盖 shell 上方内容；
- 默认只拥有最后 32 个 live rows；可以在 owned tail 内用有界 relative movement/row-local erase，但禁止 `CUP`、`ED`、scroll region、`IL/DL/SU/SD` 和 clear-scrollback；
- seal 顶部 live row 只是缩小 owned range，使它成为终端历史；不发 terminal scroll command，也永不再次寻址该 row；
- resize、疑似外部 stdout write 或 anchor invalidation 会冻结旧 tail、输出 `CRLF`、创建新 anchor，而不是冒险修改未知 scrollback；
- v1 main-screen image 只显示 alt text/placeholder；overlay/任意历史跳转可降级或请求临时进入 alternate surface；
- 关闭后 cursor 留在逻辑输出末尾。

这不是“关闭 alternate flag 后继续使用 alternate renderer”。它是独立 planner 和明确缩小的交互 contract。

### 12.3 `direct`：日志、pipe 与非 TTY

- 不使用 cursor movement、mouse、raw mode 或 image；
- 只输出已 seal 的有序文本/ANSI style stream；
- 检测非 TTY 时自动选择；
- stdout 永远是应用输出，诊断默认去 stderr；
- ordered records 不 coalesce、不丢弃。

## 13. Terminal capability 与输入

### 13.1 Capability handshake

能力来自静态 terminfo/env 和有超时的主动查询。顺序 state machine 至少覆盖：

- DA / XTVERSION；
- DECRQM；
- Kitty keyboard / graphics；
- synchronized output；
- focus、bracketed paste、SGR/pixel mouse；
- cell/pixel geometry；
- explicit width/scale；
- OSC color；
- Sixel registers/geometry（启用时）。

查询尾部发送 sentinel/DSR barrier。terminal reply、用户按键和 paste 可以交错；parser 必须按类型路由，不能在握手期间吞掉用户输入。每个 query 有 deadline；失败只禁用对应优化，不阻止启动。

启动先使用 conservative profile 立即渲染；主动 probe 不得让 first render 延迟超过 80 ms，并在默认 500 ms correlation window 内逐项升级能力。capability 改变增加 `capability_epoch`；普通 upgrade 等当前 patch 完成，安全 downgrade 在下一个 typed-op boundary abort/taint 后重绘。non-TTY/direct 永不 probe。

### 13.2 Bounded parser

输入 parser 是 streaming automaton，保留 incomplete suffix。默认边界：

| 输入 | 上限/策略 |
|---|---|
| CSI | 4 KiB，超限作为 protocol error 丢弃到 terminator |
| OSC | 64 KiB |
| DCS/APC | 64 KiB；确需更大图形 reply 时按 capability 显式提高但仍受 byte budget |
| bracketed paste | 64 KiB chunks 流式交给 native input；总上限默认 8 MiB |
| legacy ESC ambiguity | 默认 25 ms；Kitty keyboard 下不需要 |

大 paste 不 join 成单个 JS string。`TextInput` 在 native 以 chunk 应用；业务 listener 可接收 `pasteStart/chunk/end`。所有事件是结构化对象：key、codepoint、modifiers、repeat、kind、position、pixel position、timestamp 和 sequence。

### 13.3 Focus、selection、IME

- focus tree 与 hit index 在 native；tab order 由 semantics order 和显式 `tabIndex` 决定；
- pointer capture、drag selection 和 autoscroll 在 native；
- selection 以 grapheme position 表示，不以 UTF-16 index 表示；
- JS API 同时提供 grapheme position 和按需 UTF-8/UTF-16 mapping；
- IME marker/cursor rect 只更新相关 row/cursor，不触发 root render。

JS callback 是异步 observer，不能事后 `preventDefault()` 撤回已经发生的 native 编辑/滚动。低延迟拦截必须声明为 native keymap：

```tsx
<TextInput
  keys={{
    enter: { command: "submit" },
    "ctrl+a": { command: "select-all" },
    escape: { command: "focus-previous" },
  }}
  onSubmit={handleSubmit}
/>
```

这使 input latency 不依赖 JS round trip，同时业务 action 仍以 ordered event 进入 JS。

## 14. 调度与背压

### 14.1 Priority classes

从高到低：

1. terminal input、resize、suspend/resume、writer readiness；
2. native TextInput/cursor/selection/scroll echo；
3. ordered model/document/action transactions；
4. visible measure/layout/paint；
5. visible parse/highlight；
6. prefetch、compression、index、cache maintenance。

没有固定 60 Hz tick：

- urgent input/cursor：next reactor turn；
- interactive：目标 deadline 4 ms；
- normal model updates：最多 coalesce 8 ms；
- sustained streaming：默认 16 ms，慢 sink 下自适应到更低刷新率；
- background：短 slice，检测 input 后立即 yield，并有 aging 防止永久饥饿。

### 14.2 Visual generation 与 ordered state

模型事务先进入 authoritative native model。视觉输出只有：

```text
one in-flight PatchPlan + one replaceable latest desired generation
```

中间视觉 generation 可以被更新的 desired 替换；document append、用户 action、资源 release 等 ordered state 不能被丢弃。已经部分写出的 patch 不能取消；完成后从新的 confirmed state 直接规划到最新 desired。

resize/mouse-move/hover/latest-visual 等 coalesced event 在 ordered queue 中保留一个 marker；更新只替换 marker payload，不越过其前后的 key/button/document barrier。连续 append 只有在同一 open block 且保留完整 sequence range 时才可合并。

### 14.3 Transactional writer

PatchPlan 保存 semantic op 和不可变 row/blob 引用，不预先组装任意大的字符串。encoder 使用可复用的 64 KiB byte slab 惰性产生序列；writer 在 EAGAIN 时保留准确未写 suffix，并等待 writable。

成功条件是 PatchPlan 的所有字节都已交给 OS stream，然后原子提交 `ConfirmedTerminalState` 并释放旧 snapshot。hard error 时物理终端可能已接收前缀，状态不可回滚，因此：

1. 标记 confirmed unknown；
2. 释放/恢复终端模式；
3. 发 `OutputError`；
4. 若 output 重新可用，执行 capability-safe full repaint。

resize、capability safety downgrade、suspend 等必须中断时，只能在 typed operation boundary 停止；encoder 发送预构建 abort epilogue（关闭 control string/OSC8、reset SGR/margins、结束 synchronized update），随后将 physical state 标为 tainted。alternate 从 conservative full repaint 恢复；main 冻结并 re-anchor。普通新视觉 generation 不 abort 已开始 patch。

input parser 和 model loop 不能因为 output 不可写而阻塞。

## 15. Runtime、GC 与 Memory

### 15.1 Ownership 总表

| 数据 | Owner | 生命周期/回收 |
|---|---|---|
| JS component wrapper | JS GC | finalizer 仅 enqueue release，不决定 UI 语义 |
| callback | JS handler registry | native 节点退休后按 handler ID 删除 |
| Scene node/layout/hit | runtime owner | generational arena + freelist |
| Document open block | DocumentDB | append/edit；seal 后转 immutable |
| sealed block | DocumentDB/provider | byte-budget LRU → compress → evict/provider |
| frame scratch | runtime | page arena，frame/phase reset |
| paint rows | runtime/snapshots | row-level refcount + copy-on-write |
| PatchPlan | writer | 全部写完或 hard error 后释放 |
| worker input/result | worker/runtime | generation-stamped immutable buffer |
| image/blob | BlobStore | content refcount + byte-budget eviction |

JS heap 中没有 per-cell、per-row、layout object 或历史 component tree。Rust hot loop 单 owner，所以 node 不需要 `Arc<Mutex<_>>`；只有交给 writer/worker 的 immutable row/block page 使用页级 refcount。

### 15.2 Allocation strategy

- node、layout、paint header、handler map：SoA slab + freelist；
- transient layout/compose/planner：64 KiB page frame arena；reset O(1)；
- final screen：固定 `W×H` row handles，resize 才重配；
- confirmed/in-flight/latest：共享 clean row page，dirty row copy-on-write；
- UTF-8：open block append-only chunk（默认 32 KiB）；seal 时 compact；
- EGC/style/link：inline common、spill rare、compact ID interning；
- sealed text：独立 64 KiB chunks，低优先级压缩；
- output：64 KiB reusable encode slab + 小 suffix，不保留巨型 ANSI frame；
- native allocator 默认使用可观测、可 purge 的 allocator profile；发布前由 RSS benchmark 在 mimalloc/system allocator 中二选一，不把 allocator 名称写进 ABI。

viewport 默认最多 1,048,576 cells；更大 resize 在分配前返回 capability/budget error，并保持上一个安全 grid。

arena 到达高水位后不会永久保留：连续 5 秒低于峰值 25%，或收到 memory pressure 时释放多余 page；保留能够覆盖近期 p95 的页数，避免每帧抖动。

interner 在 tombstone >25%、live bytes > cap 的 75%，或 hash probe p99 >8 时进入 writer-safe compaction。compaction mark confirmed/in-flight/latest、live fragments 和 image placements 引用的 ID，重建 page/hash table，并原子重写 compact IDs；active encoder chunk 存在时不得运行。

### 15.3 Memory profiles

所有限额以 retained allocation capacity accounting，不以对象数或逻辑长度估算。`balanced` 是库默认，资源受限的 PocketCode 部署应显式选择 `compact`：

| Pool | compact | balanced | rich |
|---|---:|---:|---:|
| Scene/layout/hit | 8 MiB | 16 MiB | 32 MiB |
| viewport/paint/frame | 8 MiB | 12 MiB | 24 MiB |
| hot document/parse | 16 MiB | 28 MiB | 96 MiB |
| images/blobs | 8 MiB | 24 MiB | 96 MiB |
| queues/patch/input | 4 MiB | 8 MiB | 16 MiB |
| reserve/fragmentation | 4 MiB | 8 MiB | 32 MiB |
| **native soft cap** | **48 MiB** | **96 MiB** | **296 MiB** |

hard cap 默认是 soft cap 的 1.25 倍，只允许单个正在完成的 atomic operation 暂时借用 reserve。越过软上限的回收顺序：

```text
cancel prefetch
→ drop cold paint/layout cache
→ compress sealed blocks
→ evict provider-backed blocks/blobs
→ shrink arenas
→ reduce overscan/keepAlive
→ reject new nonessential resource with OutOfBudget
```

ordered text append 不可静默丢弃。若没有 provider/spill 且无法为它腾出空间，事务明确返回 `OutOfMemoryBudget`，由应用决定持久化、扩容或终止。

### 15.4 History spill

首选模式是 provider-owned history：PocketCode/应用保存 transcript source of truth，PocketTUI 只保留热窗口与 height/index summary。内建 spill 可选：

- `none`：达到限额显式报错；
- `provider`：通过 stable block token 重新加载，默认；
- `encrypted-temp`：0600 临时文件、session-only key、close/crash recovery 时清理策略可配置。

不能默认把可能含 secret 的 coding-agent transcript 明文写入磁盘。

### 15.5 JS GC contract

- public handle wrapper 很小，只含 app weak ref、u64 handle 和 type tag；
- JS finalizer 不直接进入 Rust allocator，只把 release token 放入有界 finalizer queue；
- app/tree 生命周期由 `mount/remove/close` 明确控制，不能依赖 GC 时机；
- callback registry 通过 native retirement receipt 清理，即使 wrapper 仍被 JS 引用也不会泄漏 native node；
- native runtime 绝不保留裸 JS pointer；N-API reference 只用于 app-level dispatcher，close 时释放；
- native retained capacity 的变化累计为 external-memory delta；只在 Node thread 的导出调用/事件通知中以至少 64 KiB batch 更新 V8 external-memory accounting，让 JS GC 感知 native pressure；
- debug 模式记录 handle allocation source、retire epoch 和 pin owner，检测 zombie/pin leak。

### 15.6 Memory correctness gates

- 所有 cache/queue/interner/arena 都有 owner、字节计数、上限和 eviction；
- snapshot 引用形成 DAG，不允许 cycle；
- `remove + two confirmed generations` 后无 pin 的 node 必须可回收；
- 反复 resize/theme/width mode/image churn 后 RSS 回到稳定高水位；
- 1 KiB/s sink 下 60 秒保持一个 in-flight 和一个 latest desired，不按 frame 数增长；
- 1M sealed rows 不能产生 1M JS/native scene objects。

## 16. 事件、错误与生命周期细节

### 16.1 Event delivery

native→JS 事件有三种语义：

| 类别 | 例子 | 队列策略 |
|---|---|---|
| state snapshot | hover、scroll position、resize | 同 key latest-wins |
| ordered action | key、submit、click、paste chunk | 有界、有序、不可静默丢弃 |
| diagnostic | cache pressure、fallback、protocol warning | 计数聚合，严重错误有序 |

事件放在 compact Rust ring，而不是每个 event 发一次 JS callback。一个 queue-depth=1 的 thread-safe notification 只表达“有事件可读”；JS 通过 `drainEvents(dst)` 批量读入 caller-owned buffer。默认 ring 上限为 4096 events 或 2 MiB。

ordered event queue 满时，runtime 暂停读取可产生更多 ordered event 的来源，并继续处理 writer/resize/close；不会 drop key。若 OS/terminal input 本身继续涌入导致 parser byte cap，将发明确 `InputOverflow` 并进入安全恢复，而不是悄悄丢数据。

事件 callback 在 JS batch 中执行。callback 内多个 signal write 合并为一个 native transaction。handler 抛错会进入 `app.onError`，默认不崩毁 runtime；配置 `fatalEventErrors` 可转为关闭。

### 16.2 Error taxonomy

```ts
type TuiError =
  | AbiVersionError
  | InvalidTransactionError
  | StaleHandleError
  | OutOfMemoryBudgetError
  | InputOverflowError
  | TerminalProtocolError
  | CapabilityProbeTimeout
  | OutputError
  | ProviderError
  | PluginContractError
  | RuntimePanicError;
```

所有 error 包含 `code`、`operation`、`generation`、可选 handle/source map 和 `recoverable`。production 默认不包含用户文本；诊断中只记录 byte count/hash，除非用户显式打开内容日志。

### 16.3 Suspend、resume 与进程退出

收到 SIGTSTP：停止生成新 patch → 在短 deadline 内 drain 当前安全 suffix → 关闭 mouse/paste/keyboard mode → 显示 cursor → 离开 alternate → 恢复 cooked mode → 交还信号。

SIGCONT：重新获取尺寸 → 重新 probe 可能变化的能力 → raw mode → surface init → confirmed invalid → full repaint。

正常 close 也走同一恢复栈。每启用一个 terminal mode 就 push 对应 inverse action；即使 probe 中途失败也能按逆序恢复。

Rust panic 不能 unwind 穿过 N-API。边界捕获 panic、标记 runtime failed、执行 best-effort terminal recovery，并只向 JS 报 `RuntimePanicError`。

## 17. 可观测性

### 17.1 内建统计

`app.stats()` 返回轻量 snapshot：

```ts
interface RuntimeStats {
  generation: bigint;
  scene: { nodes: number; dirtyByPhase: number[] };
  document: { blocksByState: number[]; hotBytes: number; evicted: bigint };
  frames: { requested: bigint; painted: bigint; coalesced: bigint; full: bigint };
  damage: { rows: bigint; cells: bigint; semanticScrolls: bigint };
  output: { plannedBytes: bigint; writtenBytes: bigint; eagain: bigint };
  memory: { pools: Record<string, number>; rss?: number; highWater: number };
  workers: { queued: number; cancelled: bigint; staleResults: bigint };
}
```

release 构建只保留计数器；timeline trace 是显式开关。trace 事件使用 binary ring，按字节上限覆盖旧数据，不生成 JSON 于热路径。

### 17.2 Reason-coded trace

每次 phase/fallback 都记录 reason：谁使节点 dirty、为什么 boundary 失效、为什么 semantic scroll 被拒绝、为什么 planner 选择 full row、哪个 pool 触发 eviction。这样性能回归可以回答“为什么做了这些工作”，而不只是“这一帧慢”。

### 17.3 开发工具

- `POCKET_TUI_FULL_RENDER=1`：关闭增量但保持相同语义；
- `POCKET_TUI_NO_CACHE=1`：关闭可选 cache；
- `POCKET_TUI_DAMAGE_ALL=1`：强制整屏 damage；
- `POCKET_TUI_FAKE_CAPS=<profile>`：固定 terminal profile；
- `POCKET_TUI_TRACE=<path>`：输出 bounded binary trace；
- `app.inspect(handle)`：返回脱敏后的 node/layout/dirty/owner 信息。

四种 correctness mode 必须产生相同 canonical cells、cursor、style、link、image placement 和 semantics snapshot。

## 18. 正确性、安全与鲁棒性

### 18.1 Core invariants

1. native handle 永远做 generation/type validation。
2. continuation cell 永远由有效 lead 拥有。
3. damage 包含所有旧、新可观察 bounds。
4. viewport 外 block 不因普通 frame 被访问。
5. confirmed terminal state 只在完整 output plan 结束后提交。
6. ordered model/event/resource operation 不被视觉 coalescing 丢弃。
7. worker result 只在 generation 匹配时安装。
8. 每个长期容器有明确 byte bound 或外部 provider。
9. terminal mode enable 与 inverse restore 成对。
10. incremental 与 oracle full render 可逐状态比较。

### 18.2 不可信输入

- terminal replies、OSC/DCS/APC、paste、mouse coordinates 都做长度和范围校验；
- app text 中的 ESC/C0 默认被渲染为可见/过滤内容，不允许直接注入 terminal control；
- hyperlink URI 和 clipboard OSC 必须走显式 API/policy；
- image dimensions、base64/blob length、decompression ratio 有上限；
- provider/plugin 返回值做 ABI/type/size validation；
- temp spill 文件权限 0600，路径不来自未验证用户文本；
- diagnostic 默认脱敏，不写 transcript 内容。

### 18.3 Fuzz 与 property tests

- terminal input parser 持续 fuzz，特别覆盖任意 chunk boundary；
- transaction decoder fuzz，任何输入都不能越界、panic 或分配不受控；
- 随机 scene edit/resize/theme/width/capability 序列比较 incremental 与 root oracle；
- 随机 Unicode EGC/combining/ZWJ/ambiguous-width 序列检查 lead/continuation 和 selection；
- fault-injected writer 覆盖 1-byte short write、EAGAIN、EINTR、hard error；
- provider cancel/reorder/error、worker stale completion 和 app close race；
- memory pressure 在任意 phase 插入，检查不变量和最终回收。

## 19. Benchmark 与验收门禁

所有对比使用相同 Node/Bun 版本、相同 terminal dimensions、相同输入 trace 和等价最终 VT 状态。先通过 deterministic VT emulator 验证输出，再比较速度。不得把不同功能或 discard writer 的 microbench 当作跨框架胜负。

### 19.1 Trace corpus

1. idle dashboard；
2. 100k active-node 中单个 Text/颜色/布局 mutation；
3. 10k、1M、100M estimated rows 的 VirtualList；
4. 一行与一页 scroll，含 overlay/wide EGC/image；
5. 256-byte chunk 流式 Markdown 到 1 MiB；
6. bash output append、tail truncate 与 collapse；
7. TextInput typing、selection、large paste、IME；
8. resize storm、theme/width-mode 切换；
9. Kitty image 首传、移动、遮挡、释放；
10. 1 KiB/s、EAGAIN 和 short-write fake PTY；
11. 8 小时 synthetic long session 与 cache churn；
12. main-screen append/scrollback/close 与 non-TTY direct。

### 19.2 核心硬门禁

| 场景 | Gate |
|---|---|
| Idle | 0 frame、0 allocation、0 terminal byte、0 fixed wakeup |
| 1M sealed rows | live scene 仅 visible+overscan+keepAlive；普通 frame 0 history visit |
| 一行 scroll | p99 不高于 10k-row case 的 1.2×；安全时只触及新 strip |
| 100k active nodes 单 cell paint | 0 unrelated measure/layout visits；输出与 damage 成比例 |
| Streaming 256 B chunks | 0 sealed-prefix visit；final size 每翻倍 total work ≤2.2× |
| 256 KiB streaming message | 每 chunk visible-path p99 <2 ms（基准机） |
| Slow sink 60s | exactly 1 in-flight + 1 latest desired；RSS plateau；0 ordered loss |
| Cache churn | pool 不越 hard cap；压力消失后回到稳定 high-water |
| Correctness modes | normal/no-cache/full-damage/full-render 最终状态完全一致 |
| Unicode | corpus + property test 0 orphan continuation / split EGC |
| Writer fault | short write/EAGAIN 无状态提前提交；hard error 后可 full recover |
| TTE planner 200×60 | sparse p99 ≤250 µs；full-frame p99 ≤2 ms；超限走记录原因的安全 fallback |
| Small-grid planner | encoded bytes ≤ independent brute-force optimum 的 1.10× |
| Main screen | 0 forbidden opcode；不越过 owned tail；sealed row exactly once |
| Image placement | N 次移动不重传相同 payload；content upload count 与内容数相等 |

### 19.3 竞争目标

在 pinned OpenTUI 与等价 Node/Bun traces 上：

- suite geometric mean 至少 1.5×；
- long-history、leaf update、scroll、streaming 至少 2×；
- 任一主要 trace 不得慢超过 5%；
- compact profile 的稳定 native memory overhead 目标 ≤48 MiB；
- 1M provider-backed transcript 的 RSS 与总历史字节近似无关；
- input-to-visible-patch p99：无背压时 <8 ms；慢 sink 时 native input state 仍 <8 ms 更新。

这些是发布门禁，不是提前声称已经达到的 benchmark 结果。

## 20. Repository 与模块边界

建议新建独立 sibling project `pocket-tui`，复用 PocketJS 的 packaging、generational handle、batch bridge 和 allocator telemetry 经验，但不复用 pixel DrawList。

```text
pocket-tui/
  packages/
    core/                 public JS/TS API
    compiler/             TSX transform and static templates
    jsx-runtime/          JSX compiler/runtime contracts
    compat-opentui/       migration adapter
    testing/              headless runtime, trace tools, VT oracle
    terminal-profiles/    versioned capability/quirk data
  crates/
    pocket-tui-abi/       binary protocol and validation
    pocket-tui-runtime/   owner loop and scheduler
    pocket-tui-scene/     SceneDB, dirty phases, layout, hit
    pocket-tui-document/  blocks, height index, provider/spill
    pocket-tui-paint/     cells, artifacts, damage
    pocket-tui-terminal/  parser, probing, transition planner
    pocket-tui-io/        nonblocking transactional writer
    pocket-tui-napi/      Node/Bun binding
    pocket-tui-oracle/    VT model and trace runner
  fixtures/
    unicode/
    terminals/
    traces/
```

crate 之间传 typed data，不共享大而可变的 `Runtime` struct。`terminal` 不读取 SceneDB；它只看 desired artifacts、semantic records 和 confirmed state。`document` 不输出 cells；它只提供 materialized block/layout inputs。

### 20.1 Compatibility boundary

常见 OpenTUI box/text/input/scroll API 可以直接翻译成 semantic transaction。任意旧式 `render(width): string[]` 只能进入有界 slow path：

```tsx
<AnsiLeaf
  render={(width) => legacy.render(width)}
  onInput={(event) => legacy.handleInput(event.raw)}
  maxRows={200}
/>
```

`AnsiLeaf` 仅在显式 invalidation 时重新解析 ANSI，并作为一个 opaque paint boundary。PocketTUI 无法虚拟化其内部历史、优化内部 damage、提供语义 selection 或 native hit testing；telemetry 必须把其 CPU/allocation/damage 单独标出。React/Solid/旧 reconciler 也可生成 imperative transaction，但都不是 reference performance path。

## 21. 实现顺序

### Milestone 0 — Oracle 与公平基线

- binary trace schema；
- deterministic VT emulator；
- OpenTUI adapter；
- allocation/RSS/PTY backpressure telemetry；
- Unicode/input corpus。

退出条件：同一 trace 可验证最终 cells/cursor/modes/link/image state，并可重放 pinned OpenTUI。

### Milestone 1 — Runtime/ABI/Memory kernel

- N-API lifecycle；
- packed transaction decoder；
- runtime owner loop；
- generational arenas；
- byte-budget pools；
- bounded model/event queues；
- nonblocking writer skeleton。

退出条件：idle zero-work、stale-handle、GC/finalizer、slow queue、close/suspend fault tests 全绿。

### Milestone 2 — Incremental scene

- Box/Text/Row/Column/Stack/Overlay/TextInput；
- compiled template/slot；
- typed dirty queues/boundaries；
- persistent layout/paint artifact；
- row damage/full-render oracle。

退出条件：100k-node leaf mutation gate 和 correctness mode gate 全绿。

### Milestone 3 — Terminal-native engine

- capability probing/input parser；
- alternate/main/direct planner；
- semantic scroll；
- SGR/link/cursor cost planner；
- transactional PatchPlan writer；
- sync update、suspend/resume。

退出条件：scroll、short-write/EAGAIN、main-screen scrollback 和 terminal profile corpus 全绿。

### Milestone 4 — Virtual document

- DocumentDB state machine；
- B+ height index/anchor reflow；
- VirtualList/VirtualTranscript；
- append/seal/provider eviction；
- incremental Markdown/highlight worker。

退出条件：1M rows、streaming near-linear、memory profile 和 resize anchor gates 全绿。

### Milestone 5 — Protocol completeness

- Kitty keyboard/graphics、legacy fallback、mouse/focus/paste/IME；
- image content/placement cache；
- Sixel fallback；
- clipboard/link policies；
- provider/encrypted spill hardening。

退出条件：protocol fuzz、Unicode corpus、image churn、large paste 和 recovery 全绿。

### Milestone 6 — Ecosystem 与迁移

- stable API；
- OpenTUI compatibility adapter；
- devtools/trace viewer；
- terminal profile update process；
- PocketCode integration。

兼容层只把 OpenTUI calls 翻译成 semantic transaction。若旧 API 本身要求整树 frame render，会明确标注 slow path，不污染核心 API。

## 22. 必须拒绝的退化

Code review 和 benchmark 应明确阻止以下变化：

- 在 JS 每次更新重新执行整棵 component tree；
- 把 transcript 保存为每条历史一个活跃 component/signal；
- `SetText(old + chunk)` 代替 `AppendUtf8`；
- layout 全文后再 clip；
- 每帧 clear/scan 完整 screen；
- 以 ANSI `string[]` 作为 renderer IR；
- 在 output 成功前更新 last/confirmed frame；
- writer 阻塞 runtime/input thread；
- 无上限 channel、paste、mutation log、intern table 或 cache；
- per-cell heap string/ArrayList；
- image placement 变化重传 image content；
- 依赖 GC finalizer 才能恢复 terminal；
- 用 operation count 而不是实际字节/内存判断 fallback；
- 为“方便”在 debug/full path 与 production incremental path 使用不同语义。

## 23. 最终架构承诺

PocketTUI 的差异化不是单个更快的 diff 函数，而是五个互相约束的承诺：

1. **语义增量**：JS 提交变化，native 不重建世界。
2. **历史与活跃 UI 分离**：长期 transcript 不进入 GC/reactive/render tree。
3. **终端原生规划**：利用 terminal state、scroll、cursor、erase、image placement 和能力 profile，生成最低代价且可恢复的程序。
4. **从源头有界**：GC、arena、cache、queue、worker、writer、history 和 image 都有 owner 与 byte budget。
5. **oracle 驱动**：每个优化都能回退到明确 full path，并通过同一 VT 状态验证。

只有当这五点同时被原型和门禁证明后，才扩展完整 widget/CSS 生态。否则即使 microbenchmark 很漂亮，也还不是性能最好的长期 TUI runtime。

