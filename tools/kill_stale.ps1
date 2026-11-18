---
# Session Notes

# Current State
_当前会话正在处理的任务/状态_
正在执行测试环境与生产环境的站点数据同步比对任务。
1. **Token 失效排查深入**：虽然 `token.txt` 中的 JWT `exp` 显示为 2026/11/12（未过期），但调用 API 时两个环境均返回 `401 "暂未登录或token已经过期"`。初步分析认为该 Token 是 Test 域签发，可能在 Prod 域无效；或者服务端存在吊销机制。
2. **候选 Token 尝试失败**：检查了 `_cand_tokens.json` 中的 3 个历史候选 Token，全部尝试后仍返回 401。当前活跃 Token 也不可用。
3. **登录脚本行为确认**：`bluejet_login.js` 已成功启动并等待用户登录（通过 Playwright 持久化 profile）。日志显示它捕获到了新的 Bearer Token 并写入文件，且本地验证通过（resp=200），但在外部脚本 `compare_sites.js` 中再次使用新 Token 时依然报 401。这暗示可能是 X-User-Id/X-Customer-Host 头缺失、Refresh Token 机制未正确触发，或者新获取的 Token 格式/内容在 Node.js 环境中未被正确解析/携带。
4. **下一步**：需要仔细对比 `bluejet_login.js` 内部成功请求与 `compare_sites.js` 失败请求之间的 Header 差异（特别是 Authorization 字符串的完整性、Bearer 前缀、以及自定义 Header）；确认是否需要在 `compare_sites.js` 中直接复用 Playwright 上下文或确保 Header 完全一致。同时检查 `_cand_tokens.json` 结构，看是否有 Refresh Token 信息可用于主动刷新流程。

# Task Specification
_任务目标、范围和验收标准_
1. **目标**：检查测试环境站点配置（`https://test-bluejet.cxzyuan.com/#/delivery-manage/site-manage`）是否落后于生产环境（`https://bluejet.cxzyuan.com/#/delivery-manage/site-manage`）。
2. **范围**：
   - 对比两环境的所有站点数据（名称、坐标、属性等）。
   - 识别“仅在生产环境存在”的站点（需同步到测试）。
   - 识别“仅存在于测试环境”的站点（可能为测试数据，需确认是否保留）。
   - 识别“同名但内容不一致”的站点（需更新测试环境数据）。
3. **验收标准**：
   - 成功拉取两环境站点列表。
   - 生成清晰的差异报告（新增、修改、独有站点）。
   - 如有差异，提供同步至测试环境的具体 API 调用方案或执行同步。

# Files and Functions
_已修改、查看或讨论的文件与函数_
- **`d:\workspace\map_element_statistics\tools\compare_sites.js`** (新建):
  - 功能：并发请求 test 和 prod 环境的站点列表 API (`POST /strategy/station/list`)，对比 ID 集合和站点详情，输出差异报告。
  - 问题：`writeFileSync` 调用未对对象进行 `JSON.stringify` 处理（已修复）；目前因 Token 鉴权失败导致返回数据为空。
- **`d:\workspace\map_element_statistics\token.txt`**:
  - 内容：JWT Token，长度 863+，解码后 `exp` 为 2026-11-12。
  - 状态：API 校验失败 (401)，即使重新登录获取的新 Token 也面临同样问题。
- **`d:\workspace\map_element_statistics\_cand_tokens.json`**:
  - 内容：包含 3 个历史捕获的 Token 候选。
  - 状态：全部尝试验证后均返回 401。
- **`d:\workspace\map_element_statistics\tools\bluejet_login.js`**:
  - 功能：Playwright 自动化登录脚本，用于获取新的 Authorization Token。
  - 路径依赖：`D:/installer/BDDZ/lightsandbox/node/node.exe`，Chromium 位于 `C:/Users/uid06419/AppData/Local/ms-playwright/chromium-1248/`。
  - 最新行为：成功启动浏览器，等待用户登录，捕获 Token 并写入 `token.txt`，内部 fetch 验证成功（200）。

# Workflow
_执行步骤、方法或流程_
1. **准备阶段**：
   - 确认 API Base URL：Test (`https://test-bluejet.cxzyuan.com/basic-api/aid-cscm/web-api`)，Prod (`https://bluejet.cxzyuan.com/basic-api/aid-cscm/web-api`)。
   - 确认鉴权头：`Authorization: Bearer <JWT>`, `X-User-Id: 2048`, `X-Customer-Host: <domain>`。
2. **数据拉取**：
   - 使用 Node.js 脚本 `compare_sites.js` 调用 `POST /strategy/station/list` (body: `{"pageNum":1,"pageSize":50}`，需翻页直至获取全量)。
3. **比对逻辑**：
   - 以站点 `id` 或 `name` 为键构建 Map。
   - 计算集合差集（Prod - Test, Test - Prod）。
   - 对交集进行字段级深度比较。
4. **异常处理**：
   - 401 错误：检查 Token 有效期，尝试 Refresh Token 接口或重新登录。当前重点在于解决 Node.js 脚本调用时的鉴权失败问题，尽管 Playwright 内部成功。
   - 500 错误：部分接口可能假 500，需通过 List 接口反查确认。

# Errors & Corrections
_遇到的错误及修复方式_
1. **401 Unauthorized (Persistent)**:
   - 现象：所有尝试的 Token（旧 Token、候选 Token、新获取 Token）在 `compare_sites.js` 中均返回 `401 "暂未登录或token已经过期"`。
   - 原因分析：Playwright 脚本内部验证成功，但 Node.js `fetch` 失败。可能原因包括：Header 传递格式差异（如 Bearer 前缀）、自定义 Header (`X-User-Id`, `X-Customer-Host`) 缺失或不匹配、或 Token 本身在某些条件下无效。
   - 计划修复：对比 `bluejet_login.js` 和 `compare_sites.js` 的请求 Header，确保完全一致；检查是否需要传入 Refresh Token。
2. **TypeError: The "data" argument must be of type string**:
   - 现象：`compare_sites.js` 第 54 行 `fs.writeFileSync` 报错。
   - 原因：将 JavaScript 对象直接传入 `writeFileSync`，未转换为字符串。
   - 修复：使用 `JSON.stringify(obj, null, 2)` 包装数据后再写入。
3. **Bash 环境变量解析错误**:
   - 现象：`CODECHAT_EVALCODECHAT_EVAL: command not found`。
   - 原因：Bash 对 Node.js eval 字符串中的引号或特殊字符解析异常。
   - 修复：避免在 Bash 中直接内联复杂 Node.js 代码，改为写入 `.js` 文件执行，或仔细处理引号转义。

# Key Results
_已取得的成果或关键发现_
- 确认了测试与生产环境的站点管理 API 端点一致。
- 识别出当前所有可用的 JWT Token 在 Node.js 脚本环境中均被服务端拒绝 (401)，尽管它们在 Playwright 浏览器上下文中有效。这表明鉴权问题可能与客户端环境或 Header 构造有关。
- `bluejet_login.js` 能够成功通过浏览器交互获取新 Token 并通过自身验证，证明了登录流程和 Token 有效性本身没有问题。
- 初步搭建了自动化比对脚本框架，待鉴权问题解决后即可运行。

# Worklog
_按时间线记录的重要操作_
- 接收任务：对比测试与生产环境站点数据。
- 编写 `compare_sites.js` 脚本，包含 API 调用逻辑和比对逻辑。
- 首次运行脚本，遭遇 401 错误，导致列表为空，比对结果全为 0。
- 调试脚本，发现 `writeFileSync` 类型错误，需修复 JSON 序列化。
- 检查 `token.txt`，确认 JWT `exp` 为 2026-11-12，但 API 拒绝访问。
- 分析鉴权流程，准备尝试 Refresh Token 或重新登录以获取有效凭证。
- 启动 `bluejet_login.js` 重新登录，成功捕获新 Token 并写入文件。
- 验证新 Token 在 `compare_sites.js` 中仍然返回 401。
- 检查 `_cand_tokens.json` 中的历史 Token，全部尝试验证后均返回 401。
- 进一步分析 Playwright 成功与 Node.js 失败之间的差异，聚焦于 Header 和 Token 格式。