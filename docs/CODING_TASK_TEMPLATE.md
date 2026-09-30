# Coding Agent Task 模板

每个实现任务单独复制本模板，Architect Agent 评审后才可执行。

## Task ID / Name

`TASK-<AREA>-<NNN>` / `<atomic task name>`

## Objective

一句话描述一个可验证结果；不得包含整个子系统或多个未经拆分的设计决定。

## Background

关联需求、架构章节、ADR、当前行为、单位和安全不变量。

## Files Allowed To Modify

- `<exact path>`
- `docs/agent_reports/TASK-<AREA>-<NNN>.md`（本任务报告，替换为实际 Task ID）

## Files Forbidden To Modify

- 除本任务报告及明确授权的文档外，禁止修改其他 `docs/` 文件。
- `<generated/vendor/config paths>`

## Required API / Contract

列出精确类型、字段、返回值、错误码、所有权、线程上下文、超时和兼容性要求。未知项标记 `TBD`，不得自行猜测。

## Implementation Requirements

- 所有权、单位、范围、状态转移、资源释放和返回值检查。
- ISR/Task/网络上下文限制及允许的 FreeRTOS 对象。
- 硬件默认安全状态和失败时关断路径。

## Error Handling

列出可触发错误、错误类别/严重度、状态变化、重试上限、锁存和恢复条件。

## Thread Safety Requirements

列出读者/写者、队列/互斥/通知、最大阻塞时间、优先级和生命周期；禁止在控制路径做无界 I/O。

## Test Requirements

列出主机单测、台架/硬件测试、故障注入、边界输入和不可执行项（标 `[HW REQUIRED]`）。

## Acceptance Criteria

给出可逐条观察的结果、日志/波形/回读证据和精确构建命令。禁止使用“代码已优化”“功能正常”作为标准。

## Build Command / Expected Result

`<canonical command>` -> `<expected result and warnings budget>`

## Prohibited Changes

禁止改变目录架构、公共 API、并发模型、状态机、错误模型、GPIO/通道规划、持久化/通信协议或安全策略；如发现设计不足，停止并回报问题。

## Completion Report

将完整报告写入 `docs/agent_reports/TASK-<AREA>-<NNN>.md`，并在回复中只给出该文件路径和简短状态。报告必须包含：修改文件；实现内容；测试内容；Build Result；Warnings；Known Issues；Questions；所有未执行项目的 `[NOT RUN]`/`[HW REQUIRED]` 原因；Coding Agent 自评 `READY FOR ARCHITECT REVIEW`。Coding Agent 不得填写 Architect Review 的 `ACCEPTED` / `CHANGES REQUIRED` 结论。
