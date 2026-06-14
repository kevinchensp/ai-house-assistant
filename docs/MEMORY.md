# AI 找房助手项目记忆

## 项目定位

本项目目标是为内部客服提供一个 AI 找房助手。

助手不是面向租客的公开产品，而是内部客服工作台能力。它帮助客服理解客户需求、查询内部房源、推荐候选房源，并生成可复制的话术。

核心价值：

```text
找房更快
推荐更稳
话术更专业
过程可追溯
经验可沉淀
```

## 已确认的 MVP 方向

MVP 只做一个最小闭环：

```text
客服输入客户需求
-> AI 抽取需求
-> MCP 查询房源
-> 规则扩圈和排序
-> 推荐 3-5 套房
-> 生成客服话术
-> 记录客服反馈
```

MVP 暂不做：

```text
自动联系客户
自动成交
写库操作
改价
锁房
复杂 CRM
完整 GIS 系统
训练平台
```

MVP 口径更新：

```text
最小位置地理化能力属于 P0，不是后续增强。
第一版至少要能识别高频地铁站、商圈、片区和重点楼栋坐标。
第一版要能基于楼栋 lng/lat 做距离排序。
如果无法识别位置，AI 应追问，不能猜坐标。
```

当前规则口径：

```text
现有意图、追问、扩圈、地铁、排序和话术规则统一记录在 docs/RULES.md。
后续调整规则时应同步更新该文档。
```

## 关键架构决策

前端不直接连接 MCP，也不直接连接模型。

推荐架构：

```text
客服前端
  -> AI 找房助手后端
  -> LLM Provider
  -> Agent Orchestrator
  -> Skill / Policy Engine
  -> MCP Client
  -> house-ai-manager MCP Server
  -> 内部房源数据库
```

后端负责：

```text
保存 MCP Token
保存模型 API Key
维护会话
调用模型
调用 MCP
执行规则
记录日志
字段脱敏
权限控制
```

## MCP 现状

已验证 MCP 服务可访问：

```text
http://8.134.48.145:3100/mcp
```

服务信息：

```text
name: house-ai-manager-mcp
version: 0.1.0
protocolVersion: 2024-11-05
```

已验证工具：

```text
search_houses
get_house_detail
search_buildings
get_building_detail
get_house_type_summary
```

已验证可以查询到楼栋和房源数据。

当前已实现的客服咨询意图：

```text
recommend_houses：完整找房推荐
project_vacancy：项目/楼栋空房
area_inventory：区域库存概览
metro_line_inventory：地铁线路沿线库存
metro_station_inventory：具体地铁站附近库存
area_layout_availability：区域 + 户型空房
price_range：区域 + 户型价格范围
distance_ranking：距离目标点排序
```

已知问题：

```text
get_house_detail 查询 house_images 表时失败，因为当前数据库中没有 house_images 表。
resources/list 不支持，当前 MCP 主要通过 tools 暴露能力。
```

## 模拟查询结论

模拟需求：

```text
帮我找一个白云东平一室一厅，预算 1000 左右的房子
```

严格查询结果：

```text
白云东平 + 1室1厅 + 800-1200：无结果
东平 + 1室1厅 + 800-1200：无结果
东平楼栋：无结果
```

放宽到白云后有候选：

```text
白云3号公寓 701-704，1室1厅1卫，50 平，1200 元，空置
```

按 900-1100 查询有候选：

```text
白心公寓12 110，1室1厅1卫，60 平，1000 元，空置
白心公寓12 112，1室1厅1卫，60 平，1000 元，空置
白心公寓12 107，1室1厅1卫，60 平，1000 元，空置
共生公寓02店A栋 101，1室1厅1卫，40 平，1000 元，空置
```

产品判断：

```text
不能把“东平没有”直接粗暴降级成“白云区有”。
应该先做位置地理化，再按周边商圈、地铁站、距离半径扩圈。
```

## 位置策略记忆

位置需求需要从关键词升级为标准地点对象。

示例：

```json
{
  "raw": "白云东平",
  "city": "广州",
  "district": "白云区",
  "place": "东平",
  "placeType": "metro_station | business_area | village | road | poi | unknown",
  "center": {
    "lng": 113.0,
    "lat": 23.0
  },
  "confidence": 0.86
}
```

扩圈原则：

```text
地铁站：本站 -> 前后 1-3 站 -> 低换乘区域 -> 相邻商圈 -> 行政区
商圈/片区：商圈中心 -> 相邻商圈 -> 同街道/同板块 -> 行政区
小区/楼盘：小区周边 -> 周边 2-3km -> 所属商圈 -> 同街道
行政区：结合预算和户型找库存板块，并提示客服确认
```

## 模型接入记忆

模型可以用国内模型，不强绑定 OpenAI。

模型层需要抽象为 Provider：

```text
LLMProvider
- extractRequirement()
- generateSearchPlan()
- generateRecommendation()
- generateSalesReply()
```

可选模型来源：

```text
OpenAI
通义千问
DeepSeek
豆包
智谱
公司内部大模型网关
私有化模型
```

MVP 策略：

```text
模型负责理解和表达
后端负责 MCP 调用和规则执行
不要在 MVP 阶段强依赖模型原生 Function Calling
模型输出必须经过后端 schema 校验后才能进入检索流程
模型不能直接决定执行未白名单 MCP 工具
```

当前实现状态：

```text
assistant 已改为 LLMProvider.extractRequirement() 优先。
已实现 BailianLlmProvider，可通过阿里云百炼 OpenAI-compatible 接口调用 qwen-plus。
当前 MockLlmProvider 作为未配置模型或模型失败时的兜底能力，可处理部分更自然的表达。
如果 provider 抛错或输出不合法，assistant 会回退到规则解析。
其他真实国内模型/公司模型网关后续只需要实现同一个 LLMProvider 接口。
```

多轮上下文记忆：

```text
assistant 当前维护轻量 session state，保存上一轮结构化需求。
客服回复“周边可以/附近也行”时，会继承上一轮位置、预算和户型，只扩大位置范围。
客服明确说“预算可以上浮/贵点也行”时，才扩大预算上限。
如果没有历史需求，短回复仍会触发追问。
```

结构化输出需要覆盖：

```text
RequirementExtractionResult：位置、预算、户型、偏好、缺失槽位、追问问题
SearchPlan：检索步骤、工具名、参数、最大调用次数、停止条件
RecommendationResult：推荐房源、推荐原因、不完全匹配点、风险提示
SalesReply：可复制话术、语气风格、下一步推动动作
```

## Skill 与规则记忆

规则需要分层：

```text
硬规则：代码或配置
软策略：Skill
表达风格：客服话术 Skill
```

硬规则示例：

```text
1000 左右 = 800-1200
默认只查空置 status=0
推荐最多 5 套
MCP 每轮最多调用 5 次
位置扩圈 1.5km -> 3km -> 5km
```

MVP Skill：

```text
Search Policy Skill：需求抽取、位置识别、地理扩圈、检索顺序、无结果放宽、推荐理由
Sales Reply Skill：客服话术、销冠沟通结构、推进动作
```

拆分策略：

```text
MVP 先保持 Skill 粒度收敛，避免过早拆成多个模块。
灰度后根据失败案例，再拆分 Requirement、Location、Search Strategy、Recommendation 等细分 Skill。
```

## 销冠话术记忆

客服话术 Skill 可以蒸馏销冠经验。

不要只模仿个人口头禅，应沉淀沟通结构：

```text
先确认客户需求
再说明已经查询
再解释是否完全匹配
再给替代方案
再强调匹配点
最后推动下一步动作
```

典型场景：

```text
完全匹配：快速建立信心，推动看房
位置无房：解释原位置暂无，推荐周边替代
预算不足：认可预算，给守预算和上浮预算两个选择
客户犹豫：降低决策压力，提供对比
需求模糊：温和追问核心信息
```

示例方向：

```text
东平附近暂时没看到完全匹配的一室一厅 1000 左右房源。我帮您往周边扩大了一圈，优先看距离和预算都比较接近的几套。白心公寓12这几间面积有 60 平，租金刚好 1000，性价比会更稳一些。您看我先发两套最接近的给您？
```

## 验收标准记忆

MVP 验收建议使用 30-50 条真实客服需求。

通过标准：

```text
80% 以上请求能正确抽取位置、预算、户型
70% 以上请求能给出可接受房源或合理无房解释
无房时不会直接粗暴扩大到整个行政区
不会编造不存在的房源
推荐结果能追溯到 MCP 返回数据
客服能一键复制话术
MCP Token 和模型 API Key 不暴露到前端
详情接口缺图片时不会导致整体失败
```

MVP 事件埋点：

```text
message_sent
requirement_extracted
follow_up_asked
location_resolved
mcp_called
mcp_failed
recommendation_shown
reply_generated
reply_copied
feedback_submitted
viewing_intent_marked
```

核心指标口径：

```text
需求抽取准确率 = 抽取正确样本数 / 标注样本数
推荐采纳率 = 标记合适或客户要看房的推荐会话数 / 展示推荐的会话数
话术复制率 = reply_copied 会话数 / reply_generated 会话数
MCP 调用失败率 = mcp_failed 次数 / mcp_called 次数
平均响应时延 = 从 message_sent 到 recommendation_shown 或 follow_up_asked 的耗时
```

## 相关文档

- MVP 方案：[docs/superpowers/specs/2026-06-12-ai-house-assistant-mvp-design.md](superpowers/specs/2026-06-12-ai-house-assistant-mvp-design.md)
- TODO 清单：[docs/TODO.md](TODO.md)
- 规则总表：[docs/RULES.md](RULES.md)
