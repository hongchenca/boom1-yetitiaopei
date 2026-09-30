# 设计文档导航

本目录是项目的架构与验收基线，不表示固件功能已经实现。阅读顺序：

1. `PROJECT_REQUIREMENTS.md`：已知需求、当前工程事实和产品待定项。
2. `SYSTEM_ARCHITECTURE.md`：总体信号流、所有权与阶段门槛。
3. `HARDWARE_ARCHITECTURE.md`：电气安全约束及硬件 TBD 清单。
4. `SOFTWARE_ARCHITECTURE.md`：模块依赖、公共数据/服务语义、并发模型。
5. `CONTROL_ALGORITHM.md` 与 `STATE_MACHINE.md`：剂量算法与状态转移。
6. `ERROR_MODEL.md`、`CONFIGURATION.md`、`COMMUNICATION_PROTOCOL.md`：故障、配置和外部边界。
7. `TEST_PLAN.md` 与 `ACCEPTANCE_CRITERIA.md`：证据与放行标准。
8. `PHASE_1_PLAN.md`：当前阶段的详细工作包；`CODING_TASK_TEMPLATE.md`：后续实现任务的强制模板。
9. `adr/`：重要设计决策、原因和后果；`verification/`：构建与硬件证据记录。
10. `agent_reports/`：Coding Agent 完成报告和返工记录，按 Task ID 命名，由 Architect 独立验收。

11. `ARCHITECTURE_IMPLEMENTATION_PLAN.md`：2026-09-26 冻结的实时调度、滤波、分阶段控制和设备边界；`adr/ADR-0005-*`、`adr/ADR-0006-*` 记录关键决策。
12. `WEB_SERVER_PLAN.md`：网页、局域网调试、设备通信和客户服务器交付方案；它定义独立应用先在开发电脑运行、最终交客户部署的边界。

任何文档改动应同步检查其相关接口、状态、故障、测试和验收项。已采纳 ADR 的架构边界不能由 Coding Agent 在实现中自行改变。硬件值若没有来源，保持 `TBD`；设计承诺、实物事实和待验证假设必须分别标注。

当前文档状态：总体方案为首版设计基线；用户已确认 N16R8，工程已配置 Flash/PSRAM。`TASK-BASE-001` 的代码和构建已验收，其独立板上内存探测按用户决定不执行，详见 `verification/TASK-BASE-001-review.md`。PCA9685 `0x40` I2C 通讯已通过；PWM、HX711、泵、气路和负载端关断仍未验收。2026-09-27 已冻结独立网页/后台、局域网联调和客户交付边界；页面、后台、模拟器和设备通信仍待对应任务实现。
