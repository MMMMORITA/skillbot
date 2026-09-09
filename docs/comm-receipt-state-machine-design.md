# Comm 执行回执与单一状态机详细设计

> 状态：Proposed
>
> 目标分支：`skillbot-v2`
>
> 设计日期：2026-09-08
>
> 范围：JupyterLab Cell 执行闭环、Agent 工作流状态管理
>
> 不在范围：Sub-agent、Skill I/O 契约、DAG 编排

## 1. 结论

本设计解决两个已经由当前代码确认的问题：

1. 后端通过 Comm 创建 Cell 后只收到 `cell_id`，无法确认 Cell 是否开始执行、是否成功、失败原因或是否超时。
2. `AgentMagic` 同时维护 `_state`、`_busy`、`_auto_pending` 和若干集合，状态变化散落在业务函数中，存在多个真相源。

目标方案：

```text
后端生成版本化执行请求
→ 前端在指定 Notebook/Kernel 创建或替换 Cell
→ 前端发送 materialized / started / succeeded / failed 回执
→ 后端 ExecutionCoordinator 幂等聚合 batch
→ WorkflowStateMachine 通过唯一 transition(event) 改变工作流状态
→ UI、Notebook 延迟切换、自动修复均消费同一状态
```

核心决策：

- 不同步等待 Cell 执行，避免阻塞 Kernel。
- 前端 `NotebookActions.executed` 是执行生命周期结果的权威来源。
- Python `post_run_cell` 保留输出、快照和 Telemetry 采集，但不再递减 batch 计数或结束工作流。
- 删除 `_busy`，不再维护布尔状态副本。
- 删除 `_auto_pending`，待执行数量从 `ExecutionBatch` 派生。
- 前端 Panel 删除独立 `_busy` 真相源，改为缓存后端发布的 `WorkflowStateSnapshot` 并派生交互能力。
- 前端只保留一套 `skillbot:execute-cell` target。
- 每个请求携带 `request_id`、`batch_id`、`notebook_path` 和 `kernel_id`，禁止向当前焦点 Notebook 静默串写。
- 自动执行的多 Cell batch 默认串行、fail-fast，保证 Notebook 数据依赖顺序。

## 2. 背景与现状

### 2.1 当前 Comm 行为

后端入口：

```text
render_output()
→ render_code()
→ send_cell_via_comm()
→ create_comm("skillbot:execute-cell")
```

当前请求仅包含：

```json
{
  "code": "...",
  "auto": true,
  "cell_type": "code",
  "replace_cell_id": ""
}
```

前端创建或替换 Cell 后立即返回：

```json
{
  "cell_id": "..."
}
```

后端回调只执行：

```python
on_cell_id(cell_id, code)
```

此时只能证明 Cell 已创建，不能证明它已经成功执行。

### 2.2 当前执行完成推断

`AgentMagic._on_cell_run()` 通过以下方式推断 Agent Cell：

```python
is_agent_cell = "# %%agent generate code" in code
```

然后递减：

```python
self._auto_pending -= 1
```

当 `_auto_pending == 0` 时结束 Agent run。

该方案存在以下问题：

- 代码注释是关联依据，不是稳定协议。
- 没有 request ID，无法区分不同 batch。
- 用户复制带标记代码可能被误认为 Agent Cell。
- 迟到执行可能递减新 batch 的计数。
- 重复执行同一 Cell 可能再次递减。
- Notebook 或 Kernel 切换后无法证明回执属于哪个上下文。
- 前端创建失败时 `_auto_pending` 永远不会归零。
- 前端执行 Promise 失败时后端不可见。

### 2.3 前端存在重复实现

当前存在两套 Cell Comm 处理代码：

- `src/jupyter/extension/src/comm.ts`
- `src/jupyter/extension/src/panel.ts::_handleCellCommImpl`

其中：

- `index.ts` 当前没有注册 `commPlugin`；
- `panel.ts::connectKernel()` 注册一次 target；
- `panel.ts` 的插件 `register()` 又注册一次相同 target；
- 两套实现对 replace、run、错误处理和重试的行为不完全一致。

这会导致：

- 后注册者可能覆盖前注册者；
- 修复只改一处时行为漂移；
- Kernel 重启和 Notebook 切换时注册次数不透明；
- 很难为执行回执建立单一测试入口。

### 2.4 当前状态管理

现有状态：

```python
class AgentState(Enum):
    IDLE
    STREAMING
    PLAN_REVIEW
    WAITING_CONFIRM
    AUTO_FIXING
```

同时存在：

```python
self._busy
self._auto_pending
self._agent_cells
self._round_results
self._pending_result
self._pending_session_nb_path
```

`_state` 和 `_busy` 在多个业务函数中直接赋值。当前代码已经用注释标明：

```python
self._busy = False  # legacy — will be removed after refactor
```

问题不只是字段重复，而是没有统一的合法迁移校验。例如：

- `WAITING_CONFIRM` 与 `PLAN_REVIEW` 的 `_busy=False`，但都不能接受新 prompt。
- `STREAMING` 同时表示模型生成和等待 Cell 执行。
- `AUTO_FIXING` 完成后直接回到 `STREAMING`，无法表示原 batch 是否仍有 Cell。
- `_finish_agent_run()` 可以从多个调用点触发，靠 `IDLE` 判断避免重复结束。

## 3. 目标与非目标

### 3.1 目标

1. 后端可准确知道每个请求是否创建、开始、成功、失败、拒绝、取消或超时。
2. 每个执行事件可关联到 request、batch、Notebook、Kernel 和 Cell。
3. 重复、乱序和迟到回执不会破坏当前任务。
4. 自动执行多 Cell 时保持确定顺序。
5. 工作流状态只有一个权威状态机。
6. Notebook 切换、Kernel 重启、用户停止和自动修复具有明确语义。
7. 单元测试与真实 Jupyter E2E 都能验证闭环。
8. 改造可分阶段灰度，出现问题可回退旧路径。

### 3.2 非目标

本设计不处理：

- 并行 Sub-agent；
- Skill 输入输出 Schema；
- 通用 DAG；
- 多 Kernel 并行执行；
- 跨进程持久化恢复未完成 batch；
- 保存完整 Cell 输出到 Comm 消息；
- 对任意用户手工执行 Cell 建立工作流；
- 改造 Agent 模型输出协议。

## 4. 设计原则

### 4.1 不阻塞 Kernel

后端发送请求后立即返回。不能在 `send_cell_via_comm()` 中等待 Promise、轮询文件或阻塞事件，因为前端触发的下一 Cell 仍需同一个 Kernel 执行。

### 4.2 事件驱动

所有完成、失败、中断和超时都转成事件，由协调器和状态机处理。

### 4.3 状态单一来源

工作流阶段只存于 `WorkflowStateMachine.state`。UI 是否 ready、能否接收新 prompt、是否延迟 Notebook 切换都从该状态派生。

### 4.4 身份优先于焦点

不能使用 `tracker.currentWidget` 作为请求目标的唯一依据。用户可能在请求到达前切换标签页。请求必须声明目标 Notebook 和 Kernel，前端必须匹配后再写入。

### 4.5 幂等优先

回执可能重复、乱序或延迟。协调器按 `request_id + phase` 去重，终态不可被普通迟到事件覆盖。

### 4.6 执行结果与输出采集分离

- 前端回执回答“执行生命周期是否成功”。
- `post_run_cell` 回答“这次执行的代码、输出和错误详情是什么”。

前者驱动工作流，后者负责上下文、快照和 Telemetry。两者不同时修改 batch 计数。

## 5. 目标架构

```text
┌──────────────────────────────────────────────────────────────┐
│ AgentMagic                                                   │
│  user command / plan / confirmation / stop                  │
│              │                                               │
│              ▼                                               │
│ WorkflowStateMachine                                         │
│  state + transition(event) + derived capabilities           │
│              │ effects                                       │
│              ▼                                               │
│ ExecutionCoordinator                                         │
│  batch + request registry + timeout + idempotency            │
│              │                                               │
│              ▼                                               │
│ CellCommClient (Python)                                      │
│  versioned request + active comm lifecycle                   │
└──────────────┬───────────────────────────────────────────────┘
               │ skillbot:execute-cell
┌──────────────▼───────────────────────────────────────────────┐
│ CellExecutionPlugin (JupyterLab)                             │
│  resolve notebook/kernel → materialize → run → receipt       │
│              │                                               │
│              ▼                                               │
│ NotebookActions.executionScheduled / executed                │
└──────────────┬───────────────────────────────────────────────┘
               │ Comm receipt
┌──────────────▼───────────────────────────────────────────────┐
│ ExecutionCoordinator → WorkflowStateMachine.transition()     │
└──────────────────────────────────────────────────────────────┘

Python post_run_cell:
  namespace + output + snapshot + telemetry only
```

## 6. 数据模型

### 6.1 CellExecutionRequest

Python：

```python
@dataclass(frozen=True)
class CellExecutionRequest:
    protocol_version: int
    request_id: str
    batch_id: str
    notebook_path: str
    kernel_id: str
    operation: Literal["create", "replace", "run_existing"]
    code: str
    cell_type: Literal["code", "markdown"]
    auto_execute: bool
    replace_cell_id: str = ""
    run_cell_id: str = ""
    sequence_index: int = 0
    sequence_size: int = 1
    timeout_ms: int = 600_000
```

约束：

- `protocol_version` 初版固定为 `1`。
- `request_id` 每个 Cell 唯一，使用 UUID。
- `batch_id` 同一轮生成的多个 Cell 共用。
- `notebook_path` 必须非空。
- `kernel_id` 必须是发送时绑定的 Kernel。
- `operation=replace` 时必须有 `replace_cell_id`。
- `operation=run_existing` 时必须有 `run_cell_id`。
- 单次 `code` 仍受 100 KB 上限保护。

身份获取：

- `notebook_path` 使用现有前端 `_set_active_notebook_path()` 写入的权威路径；
- `kernel_id` 从 ipykernel connection file 提取，例如
  `kernel-<kernel_id>.json`；
- Python 获取不到 kernel ID 时，v1 自动执行请求应明确失败；
- 禁止把 kernel ID 留空后降级写入当前焦点 Notebook。

建议封装：

```python
def current_kernel_id() -> str:
    from ipykernel.connect import get_connection_file

    stem = Path(get_connection_file()).stem
    if not stem.startswith("kernel-"):
        raise RuntimeError("cannot resolve current kernel id")
    return stem.removeprefix("kernel-")
```

### 6.2 CellExecutionReceipt

```python
class ReceiptPhase(str, Enum):
    RECEIVED = "received"
    MATERIALIZED = "materialized"
    STARTED = "started"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    REJECTED = "rejected"
    CANCELLED = "cancelled"
```

```python
@dataclass(frozen=True)
class CellExecutionReceipt:
    protocol_version: int
    request_id: str
    batch_id: str
    notebook_path: str
    kernel_id: str
    phase: ReceiptPhase
    timestamp_ms: int
    cell_id: str = ""
    execution_count: int | None = None
    elapsed_ms: int | None = None
    error_code: str = ""
    error_message: str = ""
```

协调器在本地另外生成：

```text
timed_out
```

`timed_out` 不要求前端回传，因为超时本身说明回执缺失。

### 6.3 Request 状态

```python
class CellRequestState(Enum):
    QUEUED
    SENT
    RECEIVED
    MATERIALIZED
    STARTED
    SUCCEEDED
    FAILED
    REJECTED
    CANCELLED
    TIMED_OUT
```

终态：

```text
非自动执行或 Markdown：
  MATERIALIZED / REJECTED / CANCELLED / TIMED_OUT

自动执行 Code：
  SUCCEEDED / FAILED / REJECTED / CANCELLED / TIMED_OUT
```

`MATERIALIZED` 对自动执行请求不是终态。

### 6.4 ExecutionBatch

```python
@dataclass
class ExecutionBatch:
    batch_id: str
    notebook_path: str
    kernel_id: str
    requests: list[CellRequest]
    fail_fast: bool = True
    created_at_ms: int = 0
    finished_at_ms: int | None = None
```

派生属性：

```python
pending_count
terminal_count
failed_count
next_queued
is_terminal
is_success
```

禁止另外维护 `_auto_pending`。

## 7. Comm 协议

### 7.1 创建并执行 Cell

请求：

```json
{
  "protocol_version": 1,
  "action": "execute_cell",
  "request_id": "req_8b1a",
  "batch_id": "batch_30fa",
  "notebook_path": "risk/demo.ipynb",
  "kernel_id": "8ea9...",
  "operation": "create",
  "code": "df = load_data()",
  "cell_type": "code",
  "auto_execute": true,
  "replace_cell_id": "",
  "run_cell_id": "",
  "sequence_index": 0,
  "sequence_size": 2,
  "timeout_ms": 600000
}
```

正常回执序列：

```json
{"phase":"received", "request_id":"req_8b1a", "...":"..."}
{"phase":"materialized", "request_id":"req_8b1a", "cell_id":"cell-a", "...":"..."}
{"phase":"started", "request_id":"req_8b1a", "cell_id":"cell-a", "...":"..."}
{"phase":"succeeded", "request_id":"req_8b1a", "cell_id":"cell-a",
 "execution_count":12, "elapsed_ms":841, "...":"..."}
```

### 7.2 创建但不执行

当 `auto_execute=false` 或 `cell_type=markdown`：

```text
received → materialized
```

`materialized` 即该请求终态。

### 7.3 失败回执

```json
{
  "protocol_version": 1,
  "request_id": "req_8b1a",
  "batch_id": "batch_30fa",
  "notebook_path": "risk/demo.ipynb",
  "kernel_id": "8ea9...",
  "phase": "failed",
  "timestamp_ms": 1788800000000,
  "cell_id": "cell-a",
  "execution_count": 12,
  "elapsed_ms": 841,
  "error_code": "CELL_EXECUTION_ERROR",
  "error_message": "NameError: name 'load_data' is not defined"
}
```

错误文本上限建议 2,000 字符，不通过 Comm 发送完整 traceback 或 Cell output。

### 7.4 拒绝回执

以下情况必须 `rejected`，不能静默 return：

- Notebook 不存在；
- Notebook 路径不匹配；
- Kernel 不存在；
- Kernel ID 不匹配；
- `replace_cell_id` 不存在；
- `run_cell_id` 不存在；
- Cell 类型非法；
- 协议版本不支持；
- request 字段缺失；
- Cell widget 在重试窗口内未出现。

标准错误码：

```text
UNSUPPORTED_PROTOCOL
INVALID_REQUEST
NOTEBOOK_NOT_FOUND
NOTEBOOK_MISMATCH
KERNEL_NOT_FOUND
KERNEL_MISMATCH
CELL_NOT_FOUND
CELL_WIDGET_TIMEOUT
CELL_EXECUTION_ERROR
COMM_SEND_ERROR
```

### 7.5 Kernel 忙时的消息时序

Jupyter Kernel 执行长 Cell 时，前端发回的 Comm 消息可能在 shell channel 排队，
直到当前 Cell 结束或被中断后才由 Python 处理。因此：

- 每个 receipt 必须携带前端事件发生时的 `timestamp_ms`；
- 前端可根据本地 `executionScheduled/executed` 即时显示 Cell 级状态；
- 本地显示不能直接改变后端 WorkflowState；
- 后端恢复处理后，按合法顺序快速消费 queued receipts；
- 超时按事件时间和本地接收时间分别记录，避免把“Kernel 忙导致回执延迟”误判
  为前端没有执行；
- Stop 必须保留前端直接 `kernel.interrupt()`，不能等待后端先收到 `/stop`。

Coordinator 记录：

```text
event_timestamp_ms
received_timestamp_ms
delivery_delay_ms = received - event
```

执行超时判断采用前端 `started` 时间；尚未收到 `started` 时使用发送时间，但
Kernel busy 且前端已本地 started 的场景由前端 Stop 和最终 queued receipt 收口。

## 8. 前端设计

### 8.1 单一插件

以 `src/jupyter/extension/src/comm.ts` 为唯一执行实现：

- 导出 `cellExecutionPlugin`；
- 在 `index.ts` 注册；
- 删除 `panel.ts::_handleCellComm` 和 `_handleCellCommImpl`；
- 删除 `panel.ts` 中两处 `registerCommTarget("skillbot:execute-cell")`；
- Panel 只处理聊天 Comm，不再持有 Cell 执行协议。

### 8.2 精确定位 Notebook

收到请求后：

1. 从 tracker widgets 中按 `context.path` 找到 `notebook_path`。
2. 读取该 widget 的 `sessionContext.session.kernel.id`。
3. 与请求 `kernel_id` 比较。
4. 任一不一致则拒绝。

禁止回退到当前焦点 Notebook。

### 8.3 Cell metadata

创建或替换 Cell 时写入：

```json
{
  "skillbot": {
    "generated": true,
    "protocol_version": 1,
    "request_id": "req_8b1a",
    "batch_id": "batch_30fa",
    "sequence_index": 0
  }
}
```

用途：

- 前端 executed signal 关联 request；
- Python `post_run_cell` 可读取 request；
- 用户重复执行时可判断其来源；
- 调试时无需解析代码注释。

`# %%agent generate code` 在兼容期保留，迁移完成后不再作为身份依据。

### 8.4 执行监听

使用 JupyterLab 已提供的：

```ts
NotebookActions.executionScheduled
NotebookActions.executed
```

行为：

- `executionScheduled` 命中 request metadata 后发送 `started`。
- `executed` 命中后发送 `succeeded` 或 `failed`。
- `failed` 使用 `KernelError.errorName/errorValue` 生成有界错误文本。
- 监听器按 request_id 去重。
- `NotebookActions.run()` 返回 `false` 且没有产生 `executed` signal 时，发送
  `failed/CELL_EXECUTION_NOT_STARTED`。

不只依赖 `NotebookActions.run()` Promise：

- Promise 可确认整体操作布尔结果；
- `executed` signal 同时提供 Cell 和 KernelError；
- metadata 能稳定关联 request。

### 8.5 Comm 生命周期

每个请求使用一个 Comm：

- 后端发送 request；
- 前端发送回执；
- 收到终态后前端关闭 Comm；
- 非自动请求在 `materialized` 后关闭；
- 前端异常时尽可能先发送 `rejected` 再关闭。

后端维护 active Comm 强引用，避免依赖 GC。

## 9. 后端 Comm Client

### 9.1 新模块

建议新增：

```text
src/jupyter/cell_execution.py
```

包含：

- `CellExecutionRequest`
- `CellExecutionReceipt`
- `CellCommClient`
- `ExecutionBatch`
- `ExecutionCoordinator`

`comm.py` 保留通用 Comm 辅助，或由 `cell_execution.py` 完整接管执行协议。

### 9.2 CellCommClient

接口：

```python
class CellCommClient:
    def send(
        self,
        request: CellExecutionRequest,
        on_receipt: Callable[[CellExecutionReceipt], None],
    ) -> None:
        ...

    def cancel(self, request_id: str) -> None:
        ...

    def close_all(self, reason: str) -> None:
        ...
```

职责：

- 序列化请求；
- 保存 `request_id -> comm`；
- 解析和校验回执；
- terminal 后关闭并移除 Comm；
- Comm 解析错误转为本地 `REJECTED`；
- Kernel 切换时关闭全部 active Comm。

### 9.3 兼容 API

迁移期保留：

```python
send_cell_via_comm(...)
```

内部转换为新 request。旧 `on_cell_id` 在首次 `materialized` 时调用，保证 plan cell 和现有测试不立即失效。

新代码不再新增 `on_cell_id` 调用，应使用 `on_receipt` 或 Coordinator。

### 9.4 render 集成

当前 `render_output()` 在循环中直接调用 `render_code()`，因此多个 Cell 会立即
创建多个 Comm。迁移后分成两层：

```python
CellSpec(code, cell_type, replace_cell_id)
ExecutionCoordinator.submit_batch(specs, auto_execute, fail_fast=True)
```

- `AgentMagic` 的 auto/confirm/plan 实现路径通过 Coordinator 提交 batch；
- `%kb_view` 等不涉及 Cell 的渲染不变；
- plan markdown、cell restore、cell optimize 等单 Cell 路径也生成单请求 batch；
- `render_code()` 在兼容期保留，内部委托单请求 batch；
- 迁移结束后，`render_output()` 只负责文本、图片、文件等渲染，Cell 执行由
  Coordinator 明确接管。

## 10. ExecutionCoordinator

### 10.1 职责

- 创建 batch；
- 为每个 Cell 创建 request；
- 默认串行派发；
- 校验回执身份；
- 执行幂等状态推进；
- 管理 materialize timeout 和 execution timeout；
- fail-fast；
- 汇总 batch 结果；
- 向 WorkflowStateMachine 发送领域事件。

### 10.2 串行执行

自动执行多个 Cell 时：

```text
发送 request[0]
→ succeeded
→ 发送 request[1]
→ succeeded
→ batch_succeeded
```

理由：

- Notebook Cell 常有变量依赖；
- 避免多个 `NotebookActions.run()` 同时修改 active cell；
- 失败时不会继续执行依赖错误结果的后续 Cell；
- request 与结果关联更简单。

非自动模式可连续 materialize 全部 Cell，但仍按 request 顺序等待 `materialized`，避免 active index 竞争。

### 10.3 幂等规则

允许：

```text
QUEUED → SENT → RECEIVED → MATERIALIZED → STARTED → SUCCEEDED
QUEUED → SENT → REJECTED
... → FAILED/CANCELLED/TIMED_OUT
```

处理规则：

- 相同 phase 重复：忽略并记 debug telemetry。
- 终态后的非终态：忽略。
- `SUCCEEDED` 后收到 `FAILED`：记录 protocol violation，不覆盖成功。
- `FAILED` 后收到 `SUCCEEDED`：记录 late contradiction，不自动翻转。
- 未知 request_id：记录 orphan receipt，不影响当前 batch。
- batch_id 不匹配：拒绝。
- Notebook/Kernel 不匹配：拒绝。

### 10.4 超时

两类超时：

```text
materialize_timeout：请求发送后未收到 materialized
execution_timeout：started 后未收到 terminal receipt
```

建议默认值：

- materialize：5 秒；
- execution：沿用 Agent timeout，默认 600 秒。

超时检查不能创建阻塞线程等待 Kernel。可使用轻量 timer，timer 回调只向协调器投递 `REQUEST_TIMED_OUT`。

### 10.5 自动修复

Cell `failed` 后：

1. Coordinator 将当前 request 标成失败。
2. fail-fast，剩余 queued request 标成 cancelled。
3. StateMachine 收到 `CELL_FAILED`。
4. 若自动修复次数未超限，迁移到 `AUTO_FIXING`。
5. 使用失败 Cell 的 code、bounded error 和 `post_run_cell` 已采集 output 生成修复请求。
6. 修复代码创建新的 batch，不复用旧 request ID。

禁止修改已终态 batch。

## 11. 单一工作流状态机

### 11.1 状态定义

```python
class WorkflowState(Enum):
    IDLE = auto()
    AGENT_STREAMING = auto()
    PLAN_REVIEW = auto()
    WAITING_CONFIRM = auto()
    CELL_DISPATCHING = auto()
    CELL_EXECUTING = auto()
    AUTO_FIXING = auto()
    INTERRUPTING = auto()
```

说明：

- `AGENT_STREAMING`：模型正在生成文本或代码。
- `PLAN_REVIEW`：计划已经呈现，等待确认或修改。
- `WAITING_CONFIRM`：代码或继续动作等待确认。
- `CELL_DISPATCHING`：正在向前端 materialize Cell。
- `CELL_EXECUTING`：至少一个自动执行 Cell 已 started，或 batch 正等待执行终态。
- `AUTO_FIXING`：模型正在生成失败 Cell 的修复。
- `INTERRUPTING`：已经发出停止请求，等待 active Agent/Cell 收口。

### 11.2 不保留 `_busy`

替换为能力属性：

```python
@property
def accepts_new_prompt(self) -> bool:
    return self.state is WorkflowState.IDLE

@property
def awaiting_user(self) -> bool:
    return self.state in {
        WorkflowState.PLAN_REVIEW,
        WorkflowState.WAITING_CONFIRM,
    }

@property
def has_active_work(self) -> bool:
    return self.state is not WorkflowState.IDLE

@property
def should_defer_notebook_switch(self) -> bool:
    return self.state is not WorkflowState.IDLE
```

不再使用含义模糊的 `is_busy` 参与业务判断。

### 11.3 事件定义

```python
class WorkflowEvent(Enum):
    USER_PROMPT_ACCEPTED
    AGENT_RETURNED_PLAN
    AGENT_RETURNED_CODE
    AGENT_RETURNED_TEXT
    AGENT_RETURNED_EMPTY
    USER_CONFIRMED
    USER_REJECTED
    PLAN_REVISION_REQUESTED
    CELL_BATCH_CREATED
    CELL_MATERIALIZED
    CELL_STARTED
    CELL_SUCCEEDED
    CELL_FAILED
    CELL_REJECTED
    CELL_CANCELLED
    CELL_TIMED_OUT
    BATCH_SUCCEEDED
    AUTO_FIX_RETURNED_CODE
    AUTO_FIX_EXHAUSTED
    STOP_REQUESTED
    INTERRUPT_COMPLETED
    INTERNAL_ERROR
```

Notebook switch 不改变工作流状态，只在 `has_active_work` 时保存最后一个 pending path，并在回到 `IDLE` 后应用。

### 11.4 核心迁移表

| 当前状态 | 事件 | 下一状态 | 主要 Effect |
|---|---|---|---|
| IDLE | USER_PROMPT_ACCEPTED | AGENT_STREAMING | 启动模型流 |
| AGENT_STREAMING | AGENT_RETURNED_PLAN | PLAN_REVIEW | 渲染 plan、显示确认 |
| AGENT_STREAMING | AGENT_RETURNED_CODE | WAITING_CONFIRM | 默认模式显示确认 |
| AGENT_STREAMING | CELL_BATCH_CREATED | CELL_DISPATCHING | auto 模式发送首个 request |
| AGENT_STREAMING | AGENT_RETURNED_TEXT | IDLE | 文本回答完成，恢复输入 |
| AGENT_STREAMING | AGENT_RETURNED_EMPTY | IDLE | UI ready |
| PLAN_REVIEW | PLAN_REVISION_REQUESTED | AGENT_STREAMING | 请求模型修订 |
| PLAN_REVIEW | USER_CONFIRMED | CELL_DISPATCHING | 有现成代码时创建 batch |
| PLAN_REVIEW | USER_CONFIRMED | AGENT_STREAMING | 无现成代码时生成实现 |
| PLAN_REVIEW | USER_REJECTED | IDLE | 清理 plan |
| WAITING_CONFIRM | USER_CONFIRMED | CELL_DISPATCHING | 创建执行 batch |
| WAITING_CONFIRM | USER_REJECTED | IDLE | 清理 pending result |
| CELL_DISPATCHING | CELL_MATERIALIZED | CELL_DISPATCHING | 自动代码等待 started；非自动模式发下一个 |
| CELL_DISPATCHING | CELL_STARTED | CELL_EXECUTING | 前端已调度执行 |
| CELL_DISPATCHING | CELL_MATERIALIZED | CELL_DISPATCHING/IDLE | 非自动模式发下一个或完成 |
| CELL_DISPATCHING | CELL_REJECTED | IDLE | batch failed，展示错误 |
| CELL_DISPATCHING | CELL_TIMED_OUT | IDLE | materialize 超时，展示错误 |
| CELL_DISPATCHING | CELL_CANCELLED | IDLE | 停止或 Kernel 重启 |
| CELL_EXECUTING | CELL_SUCCEEDED | CELL_DISPATCHING | batch 还有下一个 request |
| CELL_EXECUTING | BATCH_SUCCEEDED | IDLE | 完成、UI ready |
| CELL_EXECUTING | CELL_FAILED | AUTO_FIXING | 可自动修复 |
| CELL_EXECUTING | CELL_FAILED | IDLE | 不修复或不可修复 |
| CELL_EXECUTING | CELL_TIMED_OUT | IDLE | 执行超时，不自动猜测结果 |
| CELL_EXECUTING | CELL_CANCELLED | IDLE | 中断已确认 |
| AUTO_FIXING | AUTO_FIX_RETURNED_CODE | CELL_DISPATCHING | 新修复 batch |
| AUTO_FIXING | AUTO_FIX_EXHAUSTED | IDLE | 展示失败 |
| 任意非 IDLE | STOP_REQUESTED | INTERRUPTING | 停模型/取消 queued request |
| INTERRUPTING | INTERRUPT_COMPLETED | IDLE | 清理并应用 pending switch |
| 任意状态 | INTERNAL_ERROR | IDLE | 记录错误并安全收口 |

### 11.5 非法迁移

`transition()` 对非法迁移：

- 不修改状态；
- 记录 `workflow_transition_rejected`；
- 开发/测试模式抛 `InvalidTransition`；
- 生产模式返回失败结果并安全提示；
- 不通过自动“猜一个状态”恢复。

例如：

```text
IDLE + CELL_SUCCEEDED
PLAN_REVIEW + CELL_STARTED
WAITING_CONFIRM + BATCH_SUCCEEDED
```

均为非法或 orphan event。

### 11.6 Transition API

```python
@dataclass(frozen=True)
class TransitionResult:
    previous: WorkflowState
    current: WorkflowState
    effects: tuple[WorkflowEffect, ...]


class WorkflowStateMachine:
    def transition(
        self,
        event: WorkflowEvent,
        payload: Mapping[str, Any] | None = None,
    ) -> TransitionResult:
        ...
```

`transition()` 只负责：

- 校验；
- 状态更新；
- 生成 effect；
- 记录迁移。

实际 I/O 由 `AgentMagic` 执行 effect，避免状态机单测依赖 Comm、Panel 或模型。

状态机同时维护单调递增的 `revision`：

```python
@dataclass(frozen=True)
class WorkflowStateSnapshot:
    state: WorkflowState
    revision: int
    active_batch_id: str = ""
    completed_cells: int = 0
    total_cells: int = 0
    message: str = ""
```

每次有效迁移都向 Panel 发送 snapshot。前端只接受更大的 revision，避免旧 Comm
消息覆盖新状态。Panel Comm 重连时主动请求最新 snapshot。

### 11.7 Effect 示例

```python
class WorkflowEffect(Enum):
    START_AGENT_STREAM
    SHOW_PLAN_CONFIRM
    SHOW_CODE_CONFIRM
    CREATE_EXECUTION_BATCH
    DISPATCH_NEXT_CELL
    START_AUTO_FIX
    CANCEL_ACTIVE_BATCH
    SEND_PANEL_READY
    APPLY_PENDING_NOTEBOOK_SWITCH
```

## 12. 关键流程

### 12.1 Auto 模式成功

```text
User              Magic/State         Coordinator       Frontend         Kernel
 | prompt              |                   |                |               |
 |-------------------->| USER_PROMPT       |                |               |
 |                     | AGENT_STREAMING   |                |               |
 |                     | model returns 2 cells              |               |
 |                     | CELL_BATCH_CREATED|                |               |
 |                     | CELL_DISPATCHING  | send req-1     |               |
 |                     |------------------>|--------------->| create cell   |
 |                     |                   |<---------------| materialized  |
 |                     | CELL_EXECUTING    |<---------------| started       |
 |                     |                   |                |-------------->|
 |                     |                   |                |<--------------|
 |                     |                   |<---------------| succeeded     |
 |                     | CELL_DISPATCHING  | send req-2     |               |
 |                     |                   |--------------->|               |
 |                     |                   |       ... succeeded ...         |
 |                     | BATCH_SUCCEEDED   |                |               |
 |                     | IDLE + ready      |                |               |
```

### 12.2 Cell 失败并自动修复

```text
CELL_EXECUTING
→ failed(req-1)
→ cancel queued req-2
→ AUTO_FIXING
→ Agent 生成修复代码
→ 新建 batch-fix-1 / req-fix-1
→ CELL_DISPATCHING
→ CELL_EXECUTING
→ succeeded
→ IDLE
```

原 batch 保持 failed，便于审计。

### 12.3 用户停止

```text
AGENT_STREAMING:
  interrupt Agent stream

CELL_DISPATCHING:
  queued request → cancelled
  已发送但未执行 → 前端收到 cancel 时尽力取消

CELL_EXECUTING:
  前端立即调用 kernel.interrupt()
  后端收到中断后取消 queued request
  当前 request 等待 cancelled/failed 或本地 timeout

任意路径最终：
  INTERRUPTING → IDLE
```

第一版不承诺强制撤销已经进入 Kernel 队列的执行，只保证：

- 不再派发后续 Cell；
- 请求状态可观测；
- 终态收敛；
- 不把迟到成功当成新任务结果。

当前 Panel 的 Stop 和 Ctrl+C 已直接调用 `kernel.interrupt()`；该能力必须保留。
原因是 Kernel 执行长 Cell 时，后端 `_panel_input("/stop")` 本身可能排队，不能
及时运行。推荐 Stop 顺序：

1. 前端立即将本地显示切为 `Stopping`；
2. 前端调用 `kernel.interrupt()`；
3. 前端发送 `/stop` 控制命令；
4. 后端处理 `KeyboardInterrupt` 或 queued stop；
5. 状态机发布权威的 `INTERRUPTING → IDLE` snapshot。

前端的 `Stopping` 只是瞬时乐观显示，不修改权威工作流状态。

### 12.4 Notebook 切换

```text
if state == IDLE:
    立即切换 session
else:
    pending_notebook_path = latest_path
```

执行请求已绑定原 Notebook 和 Kernel，因此前端不能写入新焦点 Notebook。

状态回到 IDLE 后：

1. 清理当前 session；
2. 应用最后一个 pending path；
3. 清空 pending；
4. 新 Notebook 下次 prompt 时懒初始化 session。

### 12.5 Kernel 重启

前端检测 Kernel ID 变化：

- 关闭旧 Kernel 下 active Cell Comm；
- 对未终态 request 发 `cancelled/KERNEL_RESTARTED`，发送失败则由后端 timeout；
- 重新注册唯一 execute-cell target；
- 后端 Coordinator 将旧 kernel_id batch 终止；
- StateMachine 进入 IDLE；
- 不自动在新 Kernel 重放旧代码。

不自动重放是为了避免重复副作用。

## 13. `post_run_cell` 改造

保留职责：

- `Namespace.track_cell()`；
- `_round_results` 的 output enrichment；
- Cell snapshot；
- Notebook snapshot；
- `cell_executed` Telemetry；
- 为自动修复提供完整 output/error。

移除职责：

- 不再通过代码注释判断 batch 成员；
- 不再递减 `_auto_pending`；
- 不再调用 `_finish_agent_run()`；
- 不再直接触发工作流状态迁移。

关联方式：

- 优先从 Cell metadata 读取 request_id；
- `info.cell_id` 映射 Coordinator 中已 materialized request；
- 找不到 request 时按普通用户 Cell 处理。

兼容期可继续识别 `# %%agent generate code`，只用于旧 Cell 展示和 Telemetry，不用于 batch 结束。

## 14. UI 语义

Panel 的 ready/disabled 状态必须从 WorkflowState 派生：

| 状态 | 输入框 | Stop | 确认控件 | 状态文案 |
|---|---|---|---|---|
| IDLE | 可用 | 隐藏 | 隐藏 | Ready |
| AGENT_STREAMING | 禁用 | 可用 | 隐藏 | Thinking |
| PLAN_REVIEW | 只允许反馈 | 可用 | 显示 | Review plan |
| WAITING_CONFIRM | 只允许确认/拒绝 | 可用 | 显示 | Awaiting confirmation |
| CELL_DISPATCHING | 禁用 | 可用 | 隐藏 | Creating cells |
| CELL_EXECUTING | 禁用 | 可用 | 隐藏 | Running cell i/n |
| AUTO_FIXING | 禁用 | 可用 | 隐藏 | Fixing failed cell |
| INTERRUPTING | 禁用 | 禁用 | 隐藏 | Stopping |

不再由零散调用点自行发送矛盾的 `ready`。

`SEND_PANEL_READY` 只允许由进入 `IDLE` 的 transition effect 产生。

### 14.1 前端状态同步

Panel 当前也维护 `_busy` 并据此排队 prompt、启用 Stop 和显示 spinner。迁移后：

```ts
private _workflowState: WorkflowStateSnapshot = {
  state: 'IDLE',
  revision: 0,
  active_batch_id: '',
  completed_cells: 0,
  total_cells: 0,
  message: '',
};
```

所有行为从 snapshot 派生：

```ts
acceptsNewPrompt(snapshot)
canStop(snapshot)
awaitingUser(snapshot)
statusLabel(snapshot)
```

要求：

- 删除前端 `_busy` 的业务写入；
- `text`、`result`、`ready` 消息不再隐式切换忙闲；
- `workflow_state` 是唯一权威状态消息；
- Comm 重连后前端发送 `get_workflow_state`；
- 后端返回当前 snapshot，而不是默认认为 Ready；
- prompt queue 只在 `acceptsNewPrompt=true` 时出队。

## 15. Telemetry

新增事件：

```text
cell_request_created
cell_receipt
cell_request_timeout
cell_receipt_duplicate
cell_receipt_orphan
cell_receipt_protocol_error
execution_batch_completed
workflow_transition
workflow_transition_rejected
```

建议字段：

```json
{
  "request_id": "...",
  "batch_id": "...",
  "notebook_path_hash": "...",
  "kernel_id_prefix": "...",
  "cell_id": "...",
  "phase": "...",
  "state_before": "...",
  "state_after": "...",
  "elapsed_ms": 0,
  "error_code": ""
}
```

隐私与体积：

- Telemetry 不记录完整代码；
- Notebook 路径默认 hash；
- Kernel ID 可截断；
- error message 截断；
- 完整输出仍按现有 `cell_executed` 策略处理。

核心监控指标：

```text
materialize_success_rate
execution_success_rate
materialize_timeout_rate
execution_timeout_rate
orphan_receipt_rate
duplicate_receipt_rate
illegal_transition_rate
batch_completion_p50/p95
kernel_restart_cancellation_rate
```

## 16. 兼容与迁移

### 16.1 Feature flag

增加：

```text
SKILLBOT_CELL_RECEIPTS=0|1
```

迁移期：

- `0`：旧 `cell_id + post_run_cell + _auto_pending`；
- `1`：新 request/receipt + Coordinator；
- 默认先为 `0`，E2E 通过后改为 `1`；
- 稳定一个发布周期后删除旧路径和 flag。

### 16.2 协议兼容

前端对缺少 `protocol_version` 的旧请求：

- 按 v0 处理；
- 只返回 `{cell_id}`；
- 不进入新 receipt 逻辑。

后端新路径只发送 v1。

### 16.3 分阶段提交

建议拆成 5 个独立 commit。

#### Commit 1：前端执行逻辑去重

- `comm.ts` 成为唯一实现；
- `index.ts` 注册 plugin；
- 删除 `panel.ts` 重复 handler 和 target 注册；
- 行为暂时保持 v0；
- TypeScript 单测或最小 handler 测试。

验收：创建、替换、非自动、Markdown、Kernel 重启行为与现状一致。

#### Commit 2：版本化回执协议

- Python request/receipt dataclass；
- request_id/batch_id/notebook/kernel；
- 前端 v1 解析和回执；
- active Comm 生命周期；
- 保留 `on_cell_id` 兼容。

验收：单 Cell 可观察完整 receipt 序列。

#### Commit 3：ExecutionCoordinator

- batch registry；
- 串行派发；
- 幂等；
- 超时；
- fail-fast；
- 新 Telemetry。

验收：多 Cell 成功、第二 Cell 失败、拒绝、超时、迟到回执均收敛。

#### Commit 4：单一状态机

- 新增 `workflow.py`；
- 所有状态修改改为 `transition()`；
- 删除 Python 和 Panel 的 `_busy`；
- 删除 `_auto_pending`；
- `_on_cell_run` 不再驱动完成；
- ready 只由进入 IDLE 产生；
- 增加带 revision 的 `workflow_state` snapshot 和重连同步。

验收：grep 不存在 `_busy`、`_auto_pending` 和业务函数直接写 `.state`。

#### Commit 5：真实 E2E 与默认开启

- Playwright + 真实 skillbot Kernel；
- 通过后默认 `SKILLBOT_CELL_RECEIPTS=1`；
- 清理 v0；
- 更新 `src/jupyter/dev.md`。

## 17. 文件级改动

预计新增：

```text
src/jupyter/cell_execution.py
src/jupyter/workflow.py
tests/jupyter/test_cell_execution.py
tests/jupyter/test_workflow.py
tests/jupyter/test_cell_execution_e2e.py
```

预计修改：

```text
src/jupyter/comm.py
src/jupyter/render.py
src/jupyter/magic.py
src/jupyter/extension/src/comm.ts
src/jupyter/extension/src/index.ts
src/jupyter/extension/src/panel.ts
src/jupyter/extension/lib/*
tests/jupyter/test_comm.py
tests/jupyter/test_render.py
tests/jupyter/test_notebook_session_switch.py
conf/.env.example
src/jupyter/dev.md
```

`lib/` 编译产物必须与 `src/` 同步提交。

## 18. 测试设计

### 18.1 Python 单元测试

Comm：

- v1 request 序列化；
- 非法 receipt 拒绝；
- terminal 后 Comm 关闭；
- callback 只触发一次；
- active Comm 强引用释放；
- v0 `on_cell_id` 兼容。

Coordinator：

- 单 Cell 成功；
- 多 Cell 串行成功；
- 第二 Cell 失败后剩余 cancelled；
- materialize timeout；
- execution timeout；
- duplicate receipt；
- out-of-order receipt；
- orphan request；
- batch/kernel/notebook 不匹配；
- 非自动 materialized 即完成；
- auto-fix 创建新 batch。

StateMachine：

- 每条合法迁移；
- 每条非法迁移；
- `accepts_new_prompt`；
- `awaiting_user`；
- `has_active_work`；
- Stop 从每个非 IDLE 状态收口；
- IDLE transition 只产生一次 ready；
- pending Notebook last-path-wins。

### 18.2 TypeScript 测试

将 handler 主体提取成可注入依赖的函数，Mock：

- tracker；
- notebook model；
- sessionContext；
- Comm；
- `NotebookActions` signals。

覆盖：

- 精确 Notebook path；
- Kernel mismatch；
- create；
- replace；
- replace not found；
- run existing；
- Markdown；
- `auto_execute=false`；
- widget retry timeout；
- executed success；
- KernelError failure；
- duplicate signal 去重；
- Comm send failure。

### 18.3 Python 集成测试

使用 fake Comm 顺序注入：

```text
materialized → started → succeeded
```

断言：

- Coordinator request 状态；
- batch 状态；
- WorkflowState；
- Panel effect；
- Telemetry。

### 18.4 真实 Jupyter E2E

必须使用真实 `skillbot` kernelspec 和 JupyterLab 页面验证：

1. Auto 模式生成一个成功 Cell。
2. Auto 模式生成两个有依赖 Cell，确认严格顺序。
3. 第二个 Cell 抛异常，确认 fail-fast 和错误显示。
4. 执行中切换 Notebook，确认 Cell 仍落在原 Notebook。
5. 执行中重启 Kernel，确认 batch 取消并回到 IDLE。
6. 执行中 Stop，确认不派发后续 Cell。
7. replace 不存在，确认 rejected 而不是创建新 Cell。
8. 重复 terminal receipt 不产生两次 ready。
9. 前端扩展未加载，确认 materialize timeout。
10. 刷新页面后确认旧 batch 不自动重放。

Canvas 像素检查不适用；需要 DOM、Notebook model、Kernel 状态和后台 Telemetry 四方断言。

## 19. 验收标准

### 19.1 功能

- 100% Agent 自动执行请求有 request_id 和 batch_id。
- 100% request 进入明确终态。
- 多 Cell 执行顺序稳定。
- 前端创建/执行失败可在 Panel 看到。
- Kernel/Notebook 不匹配时拒绝，不串写。
- Stop 和 Kernel 重启后最终回到 IDLE。

### 19.2 一致性

以下命令应无结果：

```bash
rg "_busy|_auto_pending" src/jupyter
rg "self\\._state\\s*=" src/jupyter/magic.py
rg "registerCommTarget\\('skillbot:execute-cell'" \
  src/jupyter/extension/src/panel.ts
```

允许的状态赋值只能存在于 `WorkflowStateMachine` 内部。
前端也不得保留 `_busy` 作为工作流真相源。

### 19.3 质量

- Python/TypeScript 新增单测全绿。
- 现有测试无新增失败。
- 修复当前 3 个 stale `trace=True` 测试，避免用既有红灯掩盖回归。
- `tsc --noEmit` 通过。
- webpack 构建通过并同步 `lib/`。
- 10 个真实 E2E 场景全部通过。

### 19.4 可观测性

- orphan receipt rate 为 0。
- illegal transition rate 为 0。
- 正常环境 materialize timeout rate 为 0。
- 每个 batch 可通过 batch_id 串起请求、回执、状态迁移和 Cell telemetry。

## 20. 风险与缓解

### 20.1 Comm 在执行期间断开

风险：收不到 terminal receipt。

缓解：

- active Comm 强引用；
- execution timeout；
- Kernel 变化主动取消；
- `post_run_cell` 记录可用于诊断，但第一版不让其竞争状态真相源。

### 20.2 JupyterLab signal 行为变化

风险：升级 JupyterLab 后 `NotebookActions` signal 行为改变。

缓解：

- 当前依赖版本支持 `executionScheduled` 和 `executed`；
- TypeScript contract test；
- 真实 E2E；
- 升级依赖时把 E2E 作为门禁。

### 20.3 Cell metadata 被用户修改

风险：执行回执无法关联。

缓解：

- request 创建到执行间隔很短；
- 前端内存 registry 同时保存 `cell_id -> request_id`；
- metadata 是恢复和调试辅助，不是唯一运行时映射。

### 20.4 状态机改造范围大

风险：一次替换所有调用点造成行为回归。

缓解：

- 先协议、后 Coordinator、最后状态机；
- 每个 commit 独立可测；
- feature flag 双路径；
- 不把 Sub-agent、DAG 混入同一 PR。

### 20.5 自动修复循环

风险：修复 batch 再失败形成无限循环。

缓解：

- retry budget 存在 WorkflowContext；
- 每次修复新 batch；
- 达到上限发 `AUTO_FIX_EXHAUSTED`；
- 旧 batch 不复活。

## 21. 后续能力的依赖关系

本设计完成后才能可靠建设：

- 受控 Sub-agent：主 Agent 可判断各子任务是否真正完成，而不是只看到任务已发出。
- Skill I/O 契约：执行型 Skill 可以绑定 request/batch 和确定终态。
- DAG：节点完成、失败、超时和取消有统一语义。

但本设计本身不预设一定要上 Sub-agent。即使后续 Sub-agent 实验没有收益，Comm 闭环和单一状态机仍能独立解决当前真实问题：

- 自动执行不可观测；
- Notebook 切换可能错配；
- 状态重复；
- 失败无法可靠收口；
- E2E 难以断言。

## 22. 被否决的替代方案

### 22.1 后端同步等待 Comm

否决原因：下一 Cell 仍需同一 Kernel 执行，同步等待会造成自锁或超时。

### 22.2 继续只依赖 `post_run_cell + _auto_pending`

否决原因：没有 request/batch 身份，无法处理创建失败、重复执行、迟到事件和
Notebook/Kernel 错配。

### 22.3 只增加回执，不改状态机

否决原因：回执会新增更多异步事件；若继续由业务函数直接改 `_state/_busy`，
竞态面反而扩大。

### 22.4 只删除 `_busy`，保留直接写 `_state`

否决原因：字段虽然少了，但合法迁移、幂等、统一 UI effect 和非法事件检测仍
不存在，不构成真正的单一状态机。

### 22.5 让前端焦点 Notebook 决定目标

否决原因：用户切换标签页后可能把 Agent 代码写入错误 Notebook，这是数据边界
问题，必须使用请求身份精确匹配。

### 22.6 在同一 PR 引入 Sub-agent 或 DAG

否决原因：扩大变量和故障面，无法判断回执/状态机本身是否正确，也违背先解决
真实痛点再评估 Sub-agent 的原则。

## 23. 推荐实施顺序

```text
P0.1 前端 execute-cell 去重
P0.2 v1 request/receipt 协议
P0.3 ExecutionCoordinator + 串行 batch
P1.1 WorkflowStateMachine
P1.2 删除 _busy/_auto_pending/直接状态赋值
P1.3 真实 Jupyter E2E
P1.4 默认开启并删除旧路径
```

在 P1.3 通过前，不开始并行 Sub-agent MVP。

## 24. 实施状态（2026-09-08）

本设计的 P0.1-P1.2 已完成代码实施：

- 前端只保留一个 `skillbot:execute-cell` target；
- v1 request/receipt 协议已接入；
- `ExecutionCoordinator` 已实现串行 batch、fail-fast、幂等、乱序保护、
  materialize/execution timeout 和取消；
- `WorkflowStateMachine` 已成为后端唯一工作流状态源；
- 后端 `_busy`、`_auto_pending` 与前端 `_busy` 已移除；
- Panel 使用带单调 `revision` 的 `workflow_state` 快照；
- Notebook path 与 Kernel ID 校验已接入；
- workflow 启动时固定目标 Notebook，切换标签页不会改变后续确认或自动修复的写入目标；
- timeout 回调调度回 Kernel I/O loop，避免工作线程直接操作 Comm；
- terminal transition 统一清理 pending result、自动修复上下文和 Cell 跟踪；
- `src/` 与 `extension/lib/` 已同步构建。

真实 JupyterLab 4.6.0 E2E 已验证：

1. 成功 Cell 收到
   `received → materialized → started → succeeded`，输出
   `skillbot-comm-e2e-ok-v2`，batch terminal，工作流回到 `IDLE`。
2. 失败 Cell 收到
   `received → materialized → started → failed`，错误为
   `RuntimeError: skillbot-comm-e2e-fail`，batch terminal，工作流回到 `IDLE`。
3. 错误 Kernel ID 请求收到 `rejected`，错误码为 `KERNEL_MISMATCH`，
   且没有创建 Cell。
4. E2E 首轮发现 terminal receipt 发送后前端立即关闭 Comm 会触发
   JupyterLab 4.6 Comm/subshell 清理竞态，表现为 Cell 已执行但后端停在
   `CELL_EXECUTING`。现改为后端在收到 terminal receipt 后关闭 Comm，
   修复后成功与失败终态均稳定送达。

自动化限制：

- Stop/cancel 的 Python 单元测试已覆盖；
- 浏览器自动化未能在 30 秒窗口内稳定定位并点击 Agent Panel 的 Stop
  控件，因此“真实 UI 点击 Stop”仍保留为人工验收项；
- 其余 7 个扩展 E2E 场景仍需在 CI 或稳定的 Playwright harness 中补齐，
  当前不能宣称第 18.4 节全部 10 个场景通过。

当前验证结果：

```text
PYTHONPATH=src .venv/bin/pytest -q tests/jupyter
155 passed

cd src/jupyter/extension
npx tsc --noEmit
passed

./scripts/jupyter.sh --rebuild
passed (JupyterLab extension webpack build)
```

P1.3 已完成成功、失败和 Kernel mismatch 三条关键链路，尚缺 Stop UI 和
完整 10 场景自动化；P1.4 暂不执行，旧协议兼容路径继续保留。
