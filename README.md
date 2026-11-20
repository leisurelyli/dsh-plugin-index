# DSH 精选插件市场索引 (`dsh-plugin-index`)

一个**完全独立、零外部 npm 依赖**的 DeepSeek Harness (DSH) **Format 1** 插件市场索引仓库，基于 Node.js 24 原生构建。

- 直接从 npm 注册表（及可选 HTTPS Git 仓库）实时采集 `dsh.bundle` 版本、兼容性范围 `engines.dsh`、多语言文案、图标与周下载量；
- 生成严格符合 DSH Format 1 规范的 `site/index.json`、外链图标 `site/icons/*` 以及可浏览的静态目录页 `site/index.html`；
- 内置独立校验器（`scripts/validate-index.mjs`）、自动化测试（`tests/index.test.mjs`）、零重定向本地预览服务（`scripts/serve.mjs`）和 GitHub Pages 自动发布工作流。

---

## 目录结构

```text
.
├── plugins.txt                  # 插件来源清单（npm 包名或 HTTPS Git 仓库 URL）
├── overrides.json               # 市场标题/简介、分类、标签与按包名配置的中英文补充
├── scripts/
│   ├── build-index.mjs          # Format 1 索引与静态目录生成器
│   ├── validate-index.mjs       # 独立 Format 1 规范校验工具
│   ├── serve.mjs                # 零重定向本地 HTTP 预览服务（默认 127.0.0.1:4173）
│   └── lib/                     # 零依赖核心模块（semver / tar / format1 / html-catalog）
├── tests/
│   └── index.test.mjs           # node:test 自动化测试套件
├── .github/workflows/
│   └── publish.yml              # GitHub Pages 定时更新与自动部署工作流
└── site/                        # 构建产物（由 `npm run build` 生成）
    ├── index.json               # 供 DSH Discover 直接订阅的 Format 1 索引
    ├── index.html               # 可视化插件目录页（支持一键复制索引 URL）
    └── icons/                   # 超过内联阈值的外链插件图标
```

---

## 快速开始：本地构建、校验与在 DSH 中预览

需要 **Node.js >= 24**（无需执行 `npm install`）：

```bash
# 1. 从 npm 官方源构建 site/index.json、site/icons/* 与 site/index.html
npm run build

# 国内网络可使用 npmmirror 镜像加速（--no-record-registry 不会把镜像地址写死到 index.json 中）
npm run build:cn

# 2. 校验格式并运行完整测试
npm run validate
npm test

# 3. 启动本地零重定向预览服务
npm run serve
```

启动后访问：

- **可视化目录页**：`http://127.0.0.1:4173/`
- **DSH 索引地址**：`http://127.0.0.1:4173/index.json`

### 在 DSH 客户端中测试添加

1. 打开 **DSH → 插件 (Plugins) → 发现 (Discover) → 自定义插件索引 (Custom plugin indexes)**；
2. 粘贴 `http://127.0.0.1:4173/index.json`（或发布后的 HTTPS 地址）；
3. 保存即可浏览分类、标签、周下载量并一键安装任意已收录插件。

---

## 如何添加新插件（自研或社区插件）

### 1. 在 `plugins.txt` 中追加一行来源

```text
# 公开 npm 包（支持普通包与 @scope 作用域包）
dsh-my-plugin
@my-org/dsh-helper

# 或者 HTTPS Git 仓库（自动识别根目录或 monorepo 中的 dsh.bundle 包，支持 release tag 与默认分支）
https://github.com/my-org/my-dsh-plugin
```

> 要求：插件的 `package.json` 必须声明 `dsh.bundle.patch` 且未设置 `"private": true`。

### 2. （可选）在 `overrides.json` 中补充分类、标签与中英文描述

若插件本身没有内置 `./locale/zh.json`，或希望指定分类与精选标签，可在 `overrides.json` 的 `plugins` 字段中按包名配置：

```json
{
  "plugins": {
    "@my-org/dsh-helper": {
      "category": "dev-tools",
      "labels": ["curated", "verified", "dsh-0.2"],
      "title": {
        "en": "My DSH Helper",
        "zh": "我的 DSH 助手"
      },
      "description": {
        "en": "Short English description (required by Format 1).",
        "zh": "简明中文说明。"
      }
    }
  }
}
```

> 提示：Format 1 要求所有多语言对象**必须包含 `en` 键**，分类与标签 ID 必须已在 `overrides.json` 顶层的 `categories` / `labels` 中声明。

### 3. 重新构建并校验

```bash
npm run build && npm test
```

### 常用构建参数

```bash
node scripts/build-index.mjs \
  --registry https://registry.npmjs.org/ \
  --inline-icon-bytes 16384 \
  --concurrency 4 \
  --timeout-ms 60000
```

- 如需为私有 npm 仓库生成索引，直接传入 `--registry https://npm.internal.example.com/`，脚本会自动把 `registry` 写入每个 npm 版本的 `source.registry`。
- 如需额外采集 `github_stars` 排序指标，设置环境变量 `GITHUB_TOKEN` 即可（不会写入索引或日志）。

---

## 发布与托管

### 方式一：GitHub Pages（推荐，已内置 CI）

1. 将本仓库推送至 GitHub，默认分支设为 `main`；
2. 进入仓库 **Settings → Pages**，将 **Source** 设为 **GitHub Actions**；
3. 每次推送到 `main`、手动触发或每日定时（UTC 03:30），[.github/workflows/publish.yml](.github/workflows/publish.yml) 会自动执行 `npm run build` + `npm test` 并将 `site/` 部署到 GitHub Pages；
4. 最终索引地址为 `https://<username>.github.io/<repo>/index.json`。

### 方式二：Cloudflare Pages

- 绑定仓库后配置：
  - Build command：`npm run build && npm test`
  - Build output directory：`site`
  - 环境变量：`NODE_VERSION=24`

### 方式三：阿里云 OSS + CDN

- 执行 `npm run build && npm test` 后，将 `site/` 目录同步上传到 OSS Bucket（如 `ossutil cp -rf site/ oss://<bucket>/dsh-market/ --update`）；
- 确保 `index.json` 与 `icons/*` 直接返回 **HTTP 200（无 301/302 重定向）**，响应头包含 `Content-Type: application/json; charset=utf-8` 与 `Access-Control-Allow-Origin: *`。

---

## 致谢与数据来源声明

- 本索引中首批精选社区插件的发现与筛选参考自 **[dsh.so](https://dsh.so)** 公开插件榜单（`https://cdn.dsh.so/market/top-rank.json`），感谢 `dsh.so` 社区开放数据复用。
- 所有插件的版本列表、安装目标、依赖兼容性、图标与周下载量均在构建时直接从公开 npm 注册表实时获取与校验。
