# 安装指南（面向 LLM / 自动化）

本指南为能操作终端与编辑文件的 LLM 或熟练用户准备。按顺序执行即可完成 `@ariga39/opencode-vision` 插件的安装、认证与验证。

## 前置条件

- opencode 已安装且能正常启动（`opencode --version` 可运行）。
- 用户已能正常使用 opencode（TUI 或 CLI 均可）。
- 插件安装本身不需要 Node / bun / pnpm，opencode 启动时用内置 bun 自动安装 npm 插件。

## 第一步：把插件加进 opencode 配置

编辑全局配置 `~/.config/opencode/opencode.json`（Windows 为 `C:\Users\<用户>\.config\opencode\opencode.json`）。若文件不存在则创建。加入 `plugin` 数组：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@ariga39/opencode-vision"]
}
```

保留原有字段，只新增/合并 `plugin` 键。scoped 包名写法正确（`@scope/name`）。

## 第二步：重启 opencode 让插件加载

完全退出并重新启动 opencode。首次启动会联网下载插件（npm 包），缓存到 `~/.cache/opencode/node_modules/`。

验证是否加载成功：新开一个会话，向 opencode 提问：

> 列出你现在有哪些 vision 相关工具？

若插件加载成功，agent 应能调用 `vision_models` 和 `vision_set_model` 这两个自定义工具（`/tools` 里也能看到）。

## 第三步：认证视觉模型（必须）

插件需要一个能看图的模型。最简单的方式是用 opencode 官方网关的免费视觉模型：

```
opencode auth login
```

完成任意 provider 的登录（推荐 `opencode`）。插件会自动从已登录 provider 的模型目录里挑支持图片输入的模型。若不登录，视觉模型不可用，插件会退化为 delegate 模式（见第五节）。

## 第四步（可选）：自定义视觉模型

默认模型为 `opencode/mimo-v2.5-free`（经 opencode 网关）。两种换法：

1. **让 agent 换**（推荐）：提示 opencode 调用 `vision_models` 列出可选模型，再调用 `vision_set_model`（参数形如 `opencode-go/kimi-k3`）持久化。选择结果写入 `~/.config/opencode/vision-model.txt`。
2. **手工指定**：直接把 `providerID/modelID` 写入 `~/.config/opencode/vision-model.txt`，例如：
   ```
   opencode-go/kimi-k3
   ```
   模型必须来自已认证/已配置的 provider，且支持图片输入。

### 指定专用视觉 provider（可选）

若不想走"已登录 provider 自动挑选"，可在 opencode.json 显式配置一个 OpenAI 兼容的视觉 provider，插件会优先使用它：

```json
{
  "plugin": ["@ariga39/opencode-vision"],
  "provider": {
    "vision-aux": {
      "options": {
        "baseURL": "https://your-vision-api.example.com/v1",
        "apiKey": "sk-xxx",
        "model": "your-vision-model"
      }
    }
  }
}
```

配置后重启 opencode。

## 第五步：行为说明（务必告知用户）

| 模式 | 触发条件 | 行为 |
| --- | --- | --- |
| replace（默认） | 插件能解析到视觉后端 | 图片被发给视觉模型描述，描述以 `[opencode-vision] Image: <描述> (saved: <路径>)` 注入对话，主模型直接使用描述 |
| delegate（自动降级） | replace 模式下无法解析到任何视觉后端（未登录、未配置、默认模型不可用） | 图片保存到系统临时目录，注入 `[opencode-vision]:image <路径>` 提示，主模型必须委托 `@vision` 子代理看图 |

- 图片临时保存位置：`<系统临时目录>/opencode-vision/`，最多 200 张，LRU 清理。
- **delegate 首次使用**时，插件会在 `~/.config/opencode/agent/vision.md` 自动创建 `vision` 子代理。创建后需要**重启一次 opencode** 子代理才生效（插件会提示用户）。

## 第六步：验证

1. 重启 opencode 后，让用户在对话中附上一张图片（或截图），并提问"这张图里有什么"。
2. replace 模式：主模型应能直接说出图片内容（描述来自视觉模型）。
3. 若没配好模型，会看到类似 `[opencode-vision] Image: <Vision API error: ...>` 的注入文本。

## 排错速查

- **`Vision API error (401/403/404)`**：模型/API key/端点不对。用 `vision_set_model` 换模型，或检查 provider 配置。
- **`[opencode-vision] Image: <vision backend unavailable...>`**：没有可用的视觉后端。执行 `opencode auth login` 或配置 `vision-aux` provider。
- **`Vision API error: request timed out`**：视觉模型 90 秒内无响应，通常是网络/代理问题，重试即可。
- **agent 不认 `vision_models`/`vision_set_model`**：插件未加载。检查 `plugin` 字段拼写、重开 opencode、看启动日志是否报错。

## 已知限制

- 插件无法通过配置项切换模式（如 `experimental.vision.mode`）。opencode 会剥离 schema 之外的配置键，这类键到不了插件。delegate 仅由"无可用视觉后端"自动触发。
- 主模型自身若支持图片输入（如部分多模态模型），插件不会干预——图片会原样传给主模型。
