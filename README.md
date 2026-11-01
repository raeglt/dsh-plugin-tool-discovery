# dsh-plugin-tool-discovery

DeepSeek Harness 的**渐进式工具发现**插件。把体积大的工具集（MCP server、可选工具包）从请求里移出去，只留一份紧凑目录；模型需要时检索，命中的工具在下一步变得可调用。

**不修改 harness 源码**：插件是仓库外的独立包，零运行时依赖，`git pull` / `pnpm install` 都不受影响。

## 机制

```
装配提示 ──► 模型读目录 ──► search_tools(query) ──► 命中项解除限制 ──► 下一步可调用
             （只有名字+一句话，没有 schema）
```

四步对应 harness 的四个既有接缝，没有新协议：

| 步骤 | 用到的接口 | 说明 |
|---|---|---|
| 隐藏 | `agent.ctx.tools.restrict({ deny })` | 只 deny 被判定为可延迟的全局工具，其余工具不受影响 |
| 编目 | `ctx.tools.schemas()` + `agent.ctx.systemPrompt.section()` | 目录是 agent 作用域内的提示段，随加载状态实时变化 |
| 检索 | 自实现的 `search_tools` 工具 | 对 `name` + `description` 做词项打分，名字命中 > 命名空间命中 > 描述命中 |
| 释放 | 先装新 deny 再 lift 旧 deny | 两条限制求交，所以任何瞬间都不会出现「什么都不 deny」的空窗 |

与 WorkBuddy 那套的区别：那边把 schema 塞进工具结果里，这边**直接让工具回到 `tools` 数组**——因为 harness 的注册表保证「呈现 / 查找 / 执行」三视图同源，不需要重复喂 schema。

### 版本兼容

宿主在两个版本之间挪动过编目接口，插件两条路径都认：

| DSH 版本 | 编目接口 | 工具可见性查询 |
|---|---|---|
| 0.2.1-rc.3 / rc.4 / rc.5 | `ctx.tools.schemas(scope?)` → `ToolSchema[]`（含 `name` / `description` / `parameters`） | `ctx.tools.get(name, scope)` |
| 0.2.2-alpha.x | `ctx.tools.definitions()` → `ToolDefinition[]` | `ctx.tools.executable(name, scope)` |

插件优先用 `schemas()`，没有就退回 `definitions()`；两者都没有则在加载时直接报错，而不是静默出一个空目录。`schemas()` 返回的字段是 `definitions()` 的子集，而目录只需要 `name` 和 `description`，所以两条路径产出完全相同的目录。

`engines.dsh` 声明为 `>=0.2.1-rc.0`，覆盖 rc.3 起的全部版本。

## 安装

### 方式 A：overlay 直接挂载（改代码即生效，不落盘）

```sh
cd /path/to/deepseek-harness
pnpm dsh web --patch /absolute/path/to/dsh-plugin-tool-discovery/overlay.local.yml
```

`overlay.local.yml` 里的 `name` 必须是指向 `index.js` 的**绝对路径**。改完插件重启即可，无需安装。

> **0.2.1-rc.5 的差异**：该版本没有构建产物 `apps/cli/lib/bin.js`，要从源码入口启动：
> `node --import tsx/esm apps/cli/src/bin.ts web --patch <overlay.local.yml>`。
> `--patch` 与 `--dump-config` 两个选项在 rc.5 里都还在。

### 方式 B：装进 profile（持久）

```sh
pnpm dsh plugin --profile web add /absolute/path/to/dsh-plugin-tool-discovery
```

包声明了 `dsh.bundle.patch`，`dsh` 会把它追加进 `dsh.profile.bundles`。`cordis.patch.yml` 按**包名**引用，Node 的模块解析才找得到。

验证层是否生效：

```sh
pnpm dsh --profile web --dump-config | grep -A 4 tool-discovery
```

## 配置

```yaml
- insert:
    - id: tool-discovery
      name: '/absolute/path/to/dsh-plugin-tool-discovery/index.js'
      config:
        defer: ['mcp__*']          # 命中这些模式的全局工具被延迟
        keepVisible: []            # 从 defer 里豁免（如 'mcp__agent-mail__*'）
        groups: []                 # 非 MCP 工具的折叠规则，见下
        silent: []                 # 隐藏但不折叠：不进目录，仍可检索到，见下
        searchTool: 'search_tools' # 检索工具名
        maxResults: 8              # 单次检索最多加载几个
        maxLoaded: 24              # 会话内累计上限，超出按 LRU 淘汰
        collapseAbove: 12          # 单个命名空间超过这么多工具时，目录里折叠成一行
        descriptionChars: 120      # 目录里每条描述截断长度
        order: 3050                # 提示段排序位（TOOL_COMPUTER_USE 3000 与 MCP_SERVERS 3100 之间）
```

默认只延迟 `mcp__*`：没有 MCP 的部署里，插件除注册一个检索工具外**不改变任何可见性**（不会调用 `restrict`）。

### 管住非 MCP 工具：`groups`

`defer` 是 glob 匹配，内置工具和插件工具一样能延迟——只要把名字写进 `defer`。但目录渲染有个天然限制：MCP 工具名里带 server（`mcp__rea__decompile` → `mcp__rea__`），能自动成组；**普通工具名没有这种约定，会各自占一行**，几十个延迟工具就又长回来了。

`groups` 解决这个问题。规则按声明顺序匹配，**首个命中生效**：

```yaml
config:
  defer: ['mcp__*', 'knowledge_*', 'dream_*']
  keepVisible: ['read', 'write', 'edit', 'bash', 'pwsh', 'grep', 'glob']
  collapseAbove: 3
  groups:
    - name: 'knowledge tools'
      match: ['knowledge_*']
    - name: 'dream tools'
      match: ['dream_*']
    - name: 'exact tools'
      match: ['compress', 'decompress']   # 精确名也支持
```

命名空间解析顺序是 **`groups` 命中 → MCP server 前缀 → 未分组**。所以 `groups` 也能覆盖 MCP 的分组方式（想把两个 server 合成一组，写一条更靠前的规则即可）。

实测（115 个工具、105 个被延迟、`collapseAbove: 3`）：目录从 74 行压到 **25 行**，14 条真实能力短语的检索命中率 **14/14**。

> **`collapseAbove` 调小的代价**：分组被折叠后目录里只剩组名和数量，模型看不到组内工具名，只能靠 `search_tools` 检索。想「目录里直接看到名字」就调大，代价是目录变长。两者是同一枚硬币。

> **延迟内置工具前先想清楚**：内置工具是 agent 干活的主语。一旦把 `bash`/`read`/`write` 这类核心工具 defer 掉，模型每次都要先检索一轮，而且检索落空就彻底卡住。建议永远把它们放进 `keepVisible`。

### 完全不占目录：`silent`

有些工具**存在但不该被广告**——典型是成套的 REST 网关工具（`api_tool_erp_*`）：它们靠 skill 或对话里点名使用，模型不需要看到清单，看到反而占上下文。

`silent` 就是给这种工具用的：命中的工具仍然被 `defer`（因此不进请求的 tools 白名单），但**不渲染进目录段**，也不计入目录头部的工具计数；而 `search_tools` 依旧能检索到它们——搜到就照常加载、照常可调用。

```yaml
config:
  defer: ['api_tool_*', 'mcp__*']
  silent: ['api_tool_*']            # 只影响渲染，不影响可检索性
  groups:
    - name: 'api-tools'
      match: ['api_tool_*']
```

三条规则要记牢：

1. **`silent` 是 `defer` 的修饰，不是替代**。没被 `defer` 命中的工具根本进不了 catalog，写 `silent` 也没用。
2. **silent 的代价是「模型不知道它存在」**。它不会自己想起去搜。所以只对「你知道会点名」的工具用，别对通用能力用。
3. 所有延迟工具都 silent 时，目录段整段消失（`renderCatalogSection` 返回 `''`），提示词里不留空标题。

实测（真实宿主，Part 5）：`api_tool_*` 设 silent 后目录只保留 1 条非 silent 条目、头部写 `1 tool is not declared`，而 `search_tools 'refund'` 仍命中 `api_tool_erp_create_refund` 并使其变为可执行。

## 行为与边界

- **加载在下一步生效。** 当前 step 的可调用集在工具批次执行前已经定好，`search_tools` 的返回里会明确说明这点。同一批次里直接调刚检索到的工具会得到 `UNKNOWN_TOOL`。
- **只延迟全局注册的工具。** `restrict` 不影响作用域内注册的工具（如子代理的 `structured_output`、preset 自己注册的 `tool-bash`），它们始终保持可见。
- **目录是全局视图。** 编目读的是全局注册表（`schemas()` / `definitions()` 不传 scope），所以作用域内注册的工具不会出现在目录里——但它们本来也永不被 defer，两个限制口径一致，不会出现「被延迟却查不到」的工具。
- **defer 模式命中作用域内工具时，整个限制装不上。** 宿主 `restrict()` 只接受全局工具名，一旦 deny 里混入 scope-local 名字就整条抛错；插件会打警告并降级为「不延迟」。默认的 `mcp__*` 不会触发（MCP 客户端是全局插件），只有把 `defer` 改成 `'*'` 且插件挂在 preset 作用域时才会遇到。
- **条件工具按名字编目。** 目录读的是注册表定义而非 `when` 求值结果，所以某个当前不可用的条件工具仍可能出现在目录里；检索后若条件不成立，调用会被正常拒绝。
- **LRU 淘汰会静默收回能力。** 超出 `maxLoaded` 时最久未检索的工具重新被 deny（重复检索会刷新它的新鲜度）；模型若仍记得它，会看到 `UNKNOWN_TOOL`。
- **检索是英文词项匹配。** harness 里工具名和描述都是英文，中文查询基本命中不到；`search_tools` 的描述里已要求模型用英文能力短语检索。
- **MCP 晚连接也会被收进目录。** 监听 `tools/change`，MCP server 在 agent 创建之后才连上时，其工具会被补进 deny 集与目录；MCP server 断开时对应的 deny 名会同步消失，不会留下 `restrict()` 认不出的死名字。
- **限制装不上时降级为「不延迟」并打日志。** 能力可见但上下文变大，好过 agent 直接起不来。
- **插件卸载会完整回收。** 限制与目录段都挂在插件 fiber 上（`ctx.effect`），卸载即回收：被延迟的工具恢复可见、目录段从提示里消失。热更新插件不会把会话打成「工具全没了」的状态。
- **`search_tool` 重名会直接让插件加载失败。** 换了名字请同步改 `searchTool`，否则注册冲突。同一个插件被挂两次（overlay + profile）也是同样的报错，这是有意的——两个实例会各装一套 deny，互相把对方的加载状态盖掉。
- **PTC 模式（`run_code`）下要经代码调用。** 该模式里模型直呼原生工具会被拒，`search_tools` 也一样；base bundle 默认 `disabled: true`，只有显式启用 `presets/ptc.patch.yml` 的部署会碰到。

## 验证状态

| 项目 | 状态 |
|---|---|
| 单元测试（66 例，纯函数 + 限制生命周期 + 打包契约 + 卸载 + 版本兼容 + 分组规则 + silent 隐藏） | `npm test` 全绿 |
| 真实 Cordis 服务栈（AgentRegistry + SystemPrompt + ToolsService + 原生执行器） | 通过，四组断言见下 |
| 真实 launcher 挂载（`pnpm dsh --patch`） | 通过：`--dump-config` 出现插件层且 `name` 解析为 `file:///…/index.js`，`dsh web --patch …` 正常启动无插件报错 |
| 双版本真实宿主（0.2.1-rc.5 与 0.2.2-alpha.2 源码树各跑一遍） | 通过，两个版本均 `ALL PASS` |
| `dsh plugin add` 装进 profile | **未实机跑过**（会写真 profile），按 launcher 源码是转发 pnpm add 生成 link 依赖，包名可解析 |
| 真实模型端到端一轮对话 | **未验证**，需要 API key |

真实服务栈探针（`tests/real-host.mjs`）覆盖：

1. **生命周期**：创建时 MCP 工具不出现在 `schemas()`；目录段按名字列出并计数；检索后仅命中项可见且可调用；**目录同步收缩**且被加载项从目录里消失；重复检索幂等；空结果不改可见性也不改 `remaining`；**agent 创建后才注册的工具仍被延迟并进入目录**；工具注销后限制不被死名字污染。
2. **上限与淘汰**：`maxLoaded` 生效，超出部分重新被 deny 并回到目录；重复检索会刷新新鲜度，淘汰的是真正最久未用的那个。
3. **空目录**：没有可延迟工具时完全不装限制，空目录不产生提示段。
4. **卸载**：插件卸载后被延迟的工具全部恢复可见、目录段从提示里消失、提示装配不报错；重新挂载能再次延迟。

接口契约是逐条对着宿主源码核过的，不是靠行为反推：`ToolDefinition.output` 必填且 `output.schema` 受 `type/oneOf/properties/required/additionalProperties/items/enum/const` 子集校验、`ToolExecutionInput.agent` 由 agent loop 以 `agent: this` 注入、`restrict()` 只接受可限制的全局名并返回 disposer、`agents.list()` 覆盖子 agent、`agent/created` 载荷为 `{ agent, source, signal }`、空 section 会被 `renderPrompt` 丢弃。

## 为什么不 import `@deepseek-ai/dsh-tools`

插件从 harness 检出之外加载，裸标识符 `@deepseek-ai/dsh-tools` 在该路径上解析不到（根 `node_modules` 里没有 `@deepseek-ai/*`，pnpm 未提升）。所以工具定义是手写的普通对象，只依赖 `ToolDefinition` 的形状：

- `parameters`：原始 JSON Schema（注册表不校验）
- `output.schema`：注册表**会**校验，限定在 `type/oneOf/properties/required/additionalProperties/items/enum/const` 子集
- 参数校验由 `parseArguments` 自己做——harness 约定工具自己验证输入

代价是没有 `defineTool` 的编译期推断；收益是升级时不会因为 peer 解析或类型变更而失效。`tests/packaging.test.mjs` 会扫描源码，禁止出现裸导入。
