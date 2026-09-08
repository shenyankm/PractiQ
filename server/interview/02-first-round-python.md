# 一面：Python 与 FastAPI 基础

本组题参考 [AI Agent Interview Guide](https://github.com/bcefghj/ai-agent-interview-guide) 的 Python 项目骨架、异步处理、测试和工程化问题，结合当前 PractiQ 实现重新整理。重点考察 Python 后端基础，不代表源仓库的 RAG、ReAct 或 Milvus 能力已在本项目实现。

## P1. `async def` 和普通 `def` 有什么区别？

**参考回答：**

- 调用普通函数会立即执行并返回结果；调用 `async def` 只创建协程对象，需要 `await` 或调度成 Task 才会运行。
- 协程在遇到 `await` 时把控制权交回事件循环，适合等待网络、模型和对象存储等 I/O。
- `async` 不会自动加速 CPU 密集计算；CPU 工作仍会阻塞事件循环。

**项目对应：** Graph 节点和 FastAPI 上传接口使用异步函数，文件解析与图片裁剪则通过 `asyncio.to_thread` 移出事件循环。

## P2. 协程、Task 和 Future 有什么区别？

**参考回答：**

- 协程是 `async def` 调用后得到的可等待计算描述，本身不等于已开始并发执行。
- Task 把协程调度到事件循环运行，并保存完成、异常或取消状态。
- Future 是更底层的“未来结果”占位对象；Task 是 Future 的一种常见实现。

**追问：** 只有需要让任务独立推进或稍后等待时才显式 `create_task`，否则直接 `await` 更简单，也更不易泄漏后台任务。

## P3. FastAPI 路由应写成 `async def` 还是 `def`？

**参考回答：**

- 调用异步 OSS 或 HTTP 客户端时用 `async def`，才能在等待期间服务其他请求。
- 纯同步且可能阻塞的库不能直接放进异步路由；可使用同步路由让框架在线程池执行，或显式 `asyncio.to_thread`。
- 不要为了形式统一把所有函数都改成 `async`，没有等待点的协程不会带来吞吐收益。

**项目对应：** `/api/uploads` 等待 OSS 操作，因此定义为异步路由。

## P4. Python 的 GIL 是什么？它对本项目有什么影响？

**参考回答：**

- 在常见 CPython 构建中，GIL 限制同一解释器内多个线程同时执行 Python 字节码。
- I/O 密集任务仍适合线程或协程，因为等待 I/O 时可以切换执行；纯 Python CPU 密集任务通常要考虑多进程或原生扩展。
- 本项目主要等待模型和 OSS，瓶颈通常不是 GIL；但大文件解析、哈希和图片处理不能长时间占住事件循环。

**追问：** Python 3.14 支持 free-threaded 构建，但不能据此假设所有依赖都已线程安全或部署环境已启用。

## P5. 为什么同步 SDK 要用 `asyncio.to_thread`？

**参考回答：**

- 同步函数若直接在事件循环线程执行，会让同一 worker 的其他协程无法推进。
- `to_thread` 把调用交给工作线程，并返回可等待对象，适合包裹 OSS SDK、同步解析器和图片处理函数。
- 它不是无限扩容方案；线程仍消耗资源，调用量还需要并发限制和超时。

**项目对应：** `storage.py` 包装 OSS SDK，`document.py` 包装文档提取和裁图。

## P6. `asyncio.gather` 适合解决什么问题？

**参考回答：**

- 它并发等待一组互不依赖的 awaitable，并按输入顺序返回结果。
- 默认情况下一个未处理异常会让 `gather` 向调用方抛错，因此单元失败是否允许降级要在任务内部明确转换。
- 对未知规模任务不能直接无限 `gather`，否则会同时占满连接、线程或远端配额。

**项目对应：** `_bounded_map` 在 `gather` 外套 `Semaphore`，只用于有明确上限的 OSS I/O。

## P7. `asyncio.Semaphore` 如何限制并发？

**参考回答：**

- Semaphore 保存可用许可数，协程进入 `async with semaphore` 前先获取许可，退出时自动释放。
- 它限制的是同时进入临界区的任务数，不限制已创建但正在等待的任务数。
- 合理值应结合连接池、远端限流、内存和延迟实测，而不是越大越好。

**项目对应：** `AI_OSS_CONCURRENCY` 控制单次 run 的 OSS 并发。

## P8. Pydantic `BaseModel`、`TypedDict` 和 `dataclass` 怎么选？

**参考回答：**

- `BaseModel` 在运行时解析和校验不可信输入，适合 API 和模型输出边界。
- `TypedDict` 主要服务静态类型检查，运行时仍是普通 `dict`，适合 LangGraph State 这类内部数据结构。
- `dataclass` 适合可信的内部值对象或配置，不自带 Pydantic 那样的输入校验。

**项目对应：** 公共契约使用 Pydantic，Graph State 使用 `TypedDict`，已校验配置使用冻结 `dataclass`。

## P9. `field_validator` 和 `model_validator` 有什么区别？

**参考回答：**

- `field_validator` 校验或规范化单个字段，例如拒绝空字符串、校验选项标签。
- `model_validator` 能同时检查多个字段之间的关系，例如文本输入与二进制元数据互斥。
- 信任边界的规则应编码进校验器，不能只写在 Prompt 或接口文档里。

**项目对应：** `DocumentUploadRequest` 和 `ParsedQuestion` 都有跨字段约束。

## P10. `TypedDict` 中的 `NotRequired` 和 `Annotated` 有什么作用？

**参考回答：**

- `NotRequired` 表示该键在字典中可以暂时不存在，适合节点逐步补齐的 Graph State。
- `Annotated[T, metadata]` 保留基础类型 `T`，同时携带框架可读取的元数据。
- LangGraph 使用 `Annotated[list[...], operator.add]` 指定并行结果的 reducer。

**追问：** reducer 追加旧状态时，新 run 若要清空列表，需要显式 `Overwrite([])`。

## P11. 为什么用 `@lru_cache(maxsize=1)` 缓存客户端对象？

**参考回答：**

- 模型客户端和 OSS 客户端创建后可以复用，没必要每个请求重复构造。
- `maxsize=1` 表达进程内单配置单例，代码比手写全局初始化和锁更少。
- 测试或配置变化时要调用 `cache_clear()`；多进程部署下每个进程仍各有一份缓存。

**项目对应：** `get_models()` 和 `get_object_store()` 使用这一模式。

## P12. 如何测试异步 FastAPI 和外部依赖？

**参考回答：**

- `pytest-asyncio` 的 auto 模式可直接运行异步测试，`httpx.AsyncClient` 可通过 ASGI transport 调用应用。
- 用 `monkeypatch` 替换模型、OSS 和环境变量，避免真实网络与副作用。
- 测试要覆盖异常、超时和部分失败，不只覆盖 200 响应。

**项目对应：** `tests/test_upload.py` 和 `test_workflows.py` 分别覆盖这些边界。

## 代码索引

- [webapp.py](../src/practiq_ai/webapp.py)
- [document.py](../src/practiq_ai/graphs/document.py)
- [contracts.py](../src/practiq_ai/contracts.py)
- [storage.py](../src/practiq_ai/storage.py)
- [pyproject.toml](../pyproject.toml)
