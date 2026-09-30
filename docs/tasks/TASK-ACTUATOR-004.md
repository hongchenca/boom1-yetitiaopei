# TASK-ACTUATOR-004：PCA9685 执行器服务与独立关断接口

## Gate

当前只确认 PCA9685 地址 `0x40` 的 I2C 通讯；OE 极性、PWM 频率、MOSFET 输入极性、功率总使能和负载端关断尚未验收。任务默认只能运行无负载测试。

## Objective

实现 PCA9685 服务的窄接口：初始化前全关、共享频率配置、通道范围检查、单泵互斥、写后回读、事务超时、I2C 故障锁存和有界 `stop_all`。独立硬件关断优先于 I2C 写入，HTTP/网页不能绕过服务。

## Required behavior

所有输出意图必须带授权来源、通道、占空比和配置版本；CH0~7 为源泵、CH8 为气路、CH9~15 保留。失败路径先请求独立关断，再尝试 PCA9685 全关；无法证明关闭时返回 FATAL。禁止直接驱动电机，禁止多泵并行，禁止无限重试。

## Allowed files

仅允许新增 `components/actuator/` 和 `docs/agent_reports/TASK-ACTUATOR-004.md`。硬件运行、PWM 波形和负载关断另列台架验收；Agent 不刷机。报告结尾 `READY FOR ARCHITECT REVIEW`。
