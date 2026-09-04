---
name: qveris-finance-research
description: 使用 FolioMind 已验证的金融 CAP 进行行情、基本面、历史序列、事件、资金流和新闻核验；仅在能力明确缺失时使用受控 Search、Inspect、Call 发现流程；不用于执行交易或给出个性化投资建议。
---

# QVeris 金融研究

## 调用顺序

1. **优先使用 `foliomind_data`**：这是 FolioMind 已审核并固化的稳定 CAP 入口，不需要先 Search 或 Inspect。支持 `quote`、`details`、`series`、`core_event`、`capital_flow`、`sentiment`、`market_news`、`index_levels` 和 `commodity`。只传入该 kind 声明的参数（个股通常使用 `symbol`；序列使用 `range`/日期；新闻、指数和商品使用对应查询字段）。
2. 如果 `foliomind_data` 明确返回 `TOOL_CACHE_MISS`、`CAPABILITY_NOT_FOUND` 或 HTTP 404，才允许对缺失能力走发现流程；认证失败、限流、超时、网络错误和 5xx 不得触发额外 Search 或模型回退。
3. 发现流程必须严格执行：先用 `qveris_search` 获取 `search_id` 和候选 `tool_id`，再用同一 `search_id` 调用 `qveris_inspect`，确认参数、覆盖市场、价格规则、时区和返回字段后，最后用 `qveris_call`。不得猜测 `tool_id`、参数或跳过 Inspect。

固定 CAP 返回空数组或缺少字段时，诚实报告“暂无可用数据”，不要为了得到结果而重复发现、切换未经审核的工具或生成示例数据。

## 研究输出

- 明确数据来源：写出实际返回的 provider、工具标识、CAP kind 和可用的来源说明；若数据是二次聚合或缺少来源信息，应明确标注。FolioMind 是独立开源客户端，不代表 QVeris 官方项目。
- 明确时间口径：每项行情、财务或新闻数据都要给出 `as of` 时间、市场时区、交易日/披露日，以及是否为实时、延迟、复权或初步值。没有可靠时间戳时，说明无法确认时点。
- 区分事实、计算和推断：原始数据、派生指标与分析判断分别陈述；展示重要计算的输入和口径。数据缺失、停牌、币种、复权、幸存者偏差等会影响结论时应提示。
- 对关键结论至少交叉核验来源或指出未核验原因。缓存命中必须标注缓存/截至时间；不要把单次接口失败、缓存结果或过期数据写成当前事实。

## 边界

研究内容仅供信息与教育用途，不构成投资、税务、法律或个性化财务建议，也不应直接下达、执行或暗示交易指令。涉及高风险、重大资金决策或用户个体约束时，建议咨询持牌专业人士。
