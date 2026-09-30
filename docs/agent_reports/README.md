# Coding Agent 报告目录

所有 Coding Agent 必须把完成报告写入本目录，文件名与 Task ID 一致：

```text
docs/agent_reports/TASK-<AREA>-<NNN>.md
```

例如：

```text
docs/agent_reports/TASK-BASE-001.md
```

报告必须包含：

- Task ID 和执行日期
- 修改文件及每个文件的变更原因
- 实现内容与接口变化
- 测试命令、工具版本和实际结果
- Build Result、Warnings、Known Issues、Questions
- `[PASS]`、`[FAIL]`、`[NOT RUN]`、`[HW REQUIRED]` 状态
- 未执行设备操作的原因，或设备操作的完整身份/产物/日志证据
- Coding Agent 自评：`READY FOR ARCHITECT REVIEW`

Coding Agent 不得写入 Architect 的最终评审结论。Architect Agent 在审查后另行给出 `ACCEPTED` 或 `CHANGES REQUIRED`。

返工时在同一任务报告中追加日期和轮次，逐条记录评审意见、修改位置、验证命令和结果；保留此前记录并在顶部标注最新轮次。预期日志必须标注为示例，不能充当实际测试证据。报告完成后，聊天回复只需提供报告路径和简短状态。
