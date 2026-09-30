# TASK-STORAGE-004：双槽配置、任务结果与事件环

## Objective

实现不阻塞控制路径的配置/结果/事件存储接口：双槽 CRC 原子提交、版本兼容检查、掉电恢复、有限事件环和异步消费契约。

## Required behavior

运行任务使用不可变配置快照；配置写入非活动槽并完整校验后切换。两槽均损坏时保持全关并报告 CFG 故障。事件记录至少包含 event_id、request_id、设备/任务/步骤 ID、单调时间、状态、错误码、质量摘要、配置/校准版本和内容哈希。安全、失败、完成事件优先保留；低等级日志可按明确计数丢弃。控制任务不能同步等待 Flash。

## Allowed files

仅允许新增 `components/storage/`、主机测试和 `docs/agent_reports/TASK-STORAGE-004.md`。不修改 `fwq`、HTTP、执行器或 sdkconfig。报告结尾 `READY FOR ARCHITECT REVIEW`。
