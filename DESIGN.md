---
name: PractiQ
description: Offline-first exam preparation & document question-bank system for macOS
colors:
  primary: "#1d4ed8"
  primary-dark: "#60a5fa"
  primary-foreground: "#ffffff"
  secondary: "#eff6ff"
  secondary-dark: "#1e293b"
  secondary-foreground: "#1d4ed8"
  secondary-foreground-dark: "#93c5fd"
  neutral-bg: "#f8fafc"
  neutral-bg-dark: "#090d16"
  neutral-fg: "#0f172a"
  neutral-fg-dark: "#f8fafc"
  card-bg: "#ffffff"
  card-bg-dark: "#0f172a"
  muted-bg: "#f1f5f9"
  muted-bg-dark: "#1e293b"
  muted-fg: "#475569"
  muted-fg-dark: "#94a3b8"
  border: "#e2e8f0"
  border-dark: "#1e293b"
  ring: "#3b82f6"
  success: "#059669"
  success-bg: "#ecfdf5"
  warning: "#d97706"
  warning-bg: "#fffbeb"
  destructive: "#9f1239"
  destructive-bg: "#fff1f2"
typography:
  display:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'
    fontSize: "1.75rem"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "-0.025em"
  headline:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.4
  title:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.4
rounded:
  sm: "0.5rem"
  md: "0.75rem"
  lg: "0.875rem"
  xl: "1rem"
  full: "9999px"
spacing:
  xs: "0.5rem"
  sm: "0.75rem"
  md: "1rem"
  lg: "1.5rem"
  xl: "2rem"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "2rem"
  button-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.secondary-foreground}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "2rem"
  card:
    backgroundColor: "{colors.card-bg}"
    textColor: "{colors.neutral-fg}"
    rounded: "{rounded.xl}"
    padding: "1.5rem"
---

# Design System: PractiQ

## Overview

**Creative North Star: "The Scholar's Desk"**

PractiQ 的视觉语言取意于“学者的案头”：平整如纸、素净克制、沉静专注。作为一款立足于 macOS 桌面端的离线备考与题库系统，它的设计首要服务于高密度的认知劳动——阅读题干材料、辨析选项、推导计算、审阅错题。界面彻底剔除营销类界面的浮夸渐变、喧闹动效与虚幻投影，让考卷、题干、答题卡与解析成为第一视觉主角。

整体界面呈现出一种严谨考究的桌面学术工匠感。静止状态下容器如同平铺在案头上的精装试卷，界线清晰而不刺眼；在动态交互中，焦点转换与状态更迭即时响应（180ms 精准平滑过渡），为长时间备考提供稳定、护眼、无干扰的心流场域。

**Key Characteristics:**
- **平整素雅（Flat-by-Default）**：常规卡片与控制板零投影，完全依赖 1px 细线边界与微妙的底色阶梯区隔层级。
- **学术蓝墨基调（Academic Cobalt & Ink）**：以冷白纸阶（#f8fafc）与深墨岩灰（#0f172a）为纸砚底色，以高辨识度钴蓝（#1d4ed8 / 暗黑 #60a5fa）作为唯一功能主强调。
- **严密的信息密度（Scholarly Rhythm）**：合理的紧凑度，材料阅读区、选项组与答题卡矩阵各安其位，支持全键盘极速切换。
- **纯粹的暗黑适应（Nocturnal Study）**：暗黑模式采用深邃暗夜黑（#090d16）与柔和石板蓝灰（#1e293b），降低眼部疲劳，保障夜间沉浸研读。

## Colors

全套调色板建立在“学术案头”与“试卷油墨”的感知对比上，严格遵循功能主导与语义明确原则。

### Primary
- **Academic Cobalt** (`#1d4ed8`，暗黑模式切换为 Sky Cobalt `#60a5fa`)：核心功能强调色。用于主行动按钮、当前选中步骤高亮、答题卡关键操作、链接与活动导航项。
- **Primary Foreground** (`#ffffff`，暗黑模式为 `#0f172a`)：高对比文字前景色。

### Secondary
- **Ice Tint** (`#eff6ff`，暗黑模式为 Slate Night `#1e293b`)：次级容器底色与浅色高亮填充，用于次级按钮、标签徽章背景及答卷草稿态。
- **Secondary Foreground** (`#1d4ed8`，暗黑模式为 Soft Sky `#93c5fd`)：次级容器中的高可读文字色。

### Neutral
- **Crisp Paper** (`#f8fafc`，暗黑模式为 Midnight Slate `#090d16`)：全局视窗与应用工作区背景底色。
- **Slate Ink** (`#0f172a`，暗黑模式为 Ghost White `#f8fafc`)：高对比主要标题与正文文本。
- **Pure Canvas** (`#ffffff`，暗黑模式为 Dark Slate `#0f172a`)：卡片面板与浮层表面色。
- **Muted Slate** (`#f1f5f9`，暗黑模式为 Deep Navy `#1e293b`)：数据表头、代码块底色与未激活选项容器。
- **Slate Charcoal** (`#475569`，暗黑模式为 Pale Slate `#94a3b8`)：元数据标签、描述文本与次级提示文字。
- **Slate Divider** (`#e2e8f0`，暗黑模式为 `#1e293b`)：精细边界线与分隔符（1px）。
- **Focus Ring Blue** (`#3b82f6`)：全局键盘无障碍聚焦环轮廓色。

### Semantic & Status
- **Verified Emerald** (背景 `#ecfdf5` / 边框 `#059669` / 文字 `#065f46`)：判分正确状态、成功通知。
- **Signal Amber** (背景 `#fffbeb` / 边框 `#d97706` / 文字 `#92400e`)：待人工审阅标记、部分得分、需要二次确认的警示。
- **Crimson Error** (背景 `#fff1f2` / 边框 `#9f1239` / 文字 `#9f1239`)：判分错误状态、危险操作、阻断性校验报错。

### Named Rules
**The One Accent Rule.** 页面中非语义状态的强调色仅允许使用 Academic Cobalt。严禁为装饰目的引入紫色、粉色、黄色或渐变，主色在整个视口的可视面积严格控制在 ≤8%。  
**The Content-First Semantic Rule.** 翠绿、琥珀与深红仅当且仅当代表判分结果（正确/待复核/错误）或系统状态反馈时使用，不可滥用为普通卡片标签或装饰点缀。

## Typography

**Display & Body Font:** `system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`  
**Monospace / Numerical Font:** `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`

**Character:** 依托 macOS 原生苹方与系统无衬线字体，字形清晰刚劲，搭配等宽数字排版，展现专业严谨的学术文本阅读体验。

### Hierarchy
- **Display** (Semi-bold 600, `1.75rem` / 28px, 行高 1.35, 字距 `-0.025em`)：应用主页与关键模块一级大标题。窄屏桌面下自适应收拢至 `1.375rem` (22px)。
- **Headline** (Semi-bold 600, `1.25rem` / 20px, 行高 1.4)：分区卡片大标题、模考成绩总分、配置栏主标题。
- **Title** (Semi-bold 600, `1.125rem` / 18px, 行高 1.5)：试卷题号、卡片标题、弹窗对话框标题。
- **Body** (Regular 400 / Medium 500, `0.875rem` / 14px, 行高 1.6 - 1.75)：题干正文、选项描述、解析段落与操作按钮文字。文本长度最舒适阅读宽度维持在 65–78ch。
- **Label / Meta** (Medium 500, `0.75rem` / 12px, 行高 1.4, 等宽数字)：题目类型徽章、做题计时器、作答进度统计与底部版权信息。

### Named Rules
**The Tabular Numerals Rule.** 所有时间倒计时、分数、题号索引与统计指标（如 7 天做题量、准确率）必须声明 `font-variant-numeric: tabular-nums`，杜绝数字跳动破坏排版节奏。  
**The Passage Flow Rule.** 长材料阅读与完形填空上下文保持行高 2.5 倍基线留白，嵌入行内的空位与标记保持行内流动（`display: inline`），保证中英文混排流畅。

## Layout

**桌面工作区空间模型（Desktop Spatial System）：**
- **全局容器最大宽度**：标准页面工作区限制为 `80rem` (1280px)，全真模考做题区扩展至 `90rem` (1440px)，独立导入工作台限制为 `820px`。
- **基础间距节奏**：以 4px / 8px 律动为基准。
  - `--space-page`: `2rem` (32px)
  - `--space-section`: `1.5rem` (24px)
  - `--space-card`: `1.5rem` (24px)
  - `--control-height`: `2.5rem` (40px)
- **双栏分栏与双向滚动（Split-Pane Architecture）**：在复合材料题与大阅读题型中，左侧材料区域固定（Sticky）并提供独立垂直滚动（`max-height: 35dvh` 或分栏阅读），右侧作答区独立平滑滚动，避免用户答题时反复上下寻找原文。
- **答题卡悬浮锚定（Persistent Answer Bar）**：在桌面端做题时，全局答题卡与底部提交/翻页控制条常驻于操作视野内，通过快捷定位随时直达任意小题。

## Elevation & Depth

**平整基底，浮层显露（Flat-by-Default）：**
PractiQ 的绝大部分表面处于纯平状态。静止的卡片、选项容器、侧边栏均采用 `box-shadow: none`，仅通过 `1px solid var(--border)` 和微弱的底色阶梯（`--background` 到 `--card`）定义边界。

### Shadow Vocabulary
- **Overlay Floating Depth** (`--overlay-shadow`):
  - 浅色模式：`0 1px 3px 0 rgb(0 0 0 / 0.05), 0 20px 45px -15px rgb(0 0 0 / 0.12)`
  - 暗黑模式：`0 1px 2px rgb(0 0 0 / 0.5), 0 18px 42px -16px rgb(0 0 0 / 0.7)`
  - 仅用于：Dialog、Alert Dialog、Dropdown Menu 与 Popover 浮层，形成清晰脱离工作台的纵深层级。
- **Toast Accent Elevation**:
  - `0 4px 24px -6px rgb(0 0 0 / 0.06), 0 1px 3px 0 rgb(0 0 0 / 0.04)`，用于右下角瞬态操作反馈（Sonner Toasts）。

### Named Rules
**The Flat-Surface Doctrine.** 页面主体内容（卡片、表格、题肢、选项按钮）静止时禁止施加任何外阴影或内阴影。只有当元素脱离平面产生层叠覆盖（Modal / Popover）时，才允许唤起结构性阴影。

## Shapes

- **圆角梯度体系**：
  - **Item / Control Radius** (`0.5rem` / 8px)：用于按钮、输入框、下拉菜单项、题肢选项边框。
  - **Menu / Toast Radius** (`0.75rem` / 12px)：用于下拉弹层、Toast 浮层、过滤工具条。
  - **Panel / Card Radius** (`1rem` / 16px)：用于题目主卡片、设置面板、模态弹窗外壳。
  - **Pill Radius** (`9999px`)：用于题型徽章（Badge）与状态开关滑块（Switch）。
- **轮廓与描边规范**：默认描边均为清晰利落的 1px 实体线；特殊待定状态（如跳过题目、待评分题目）使用 1px 虚线（`dashed`）边框表达不确定性。

## Components

### Buttons
- **Shape:** 圆角矩形（`0.5rem` / 8px）。
- **Primary:** 背景 Academic Cobalt (`#1d4ed8`)，文字纯白，悬浮微暗（`hover:bg-primary/90`），高度 `2rem` (32px) / 移动端 `3rem` (48px)。
- **Secondary:** 背景 Ice Tint (`#eff6ff`)，文字 Cobalt，悬浮略微加深底色。
- **Outline:** 背景透明或卡片白，边框 Slate Divider (`#e2e8f0`)，悬浮显露 Muted 底色。
- **Ghost:** 静态完全透明无描边，悬浮呈现浅灰背景。
- **Active / Focus:** 活跃按下瞬间沿 Y 轴轻微下沉 1px（`active:translate-y-px`）；Tab 聚焦呈现 3px 聚焦环（`ring-3 ring-ring`），边距偏移 2px。

### Cards & Panels
- **Corner Style:** 圆润面板（`1rem` / 16px）。
- **Background:** Pure Canvas (`#ffffff` / 暗黑模式 `#0f172a`)。
- **Border:** 1px 细线边界（`#e2e8f0` / 暗黑模式 `#1e293b`）。
- **Padding:** 桌面端标准 24px (`--space-card: 1.5rem`)，移动窄屏 16px。

### Inputs & Textareas
- **Style:** 边框 `#82909f`（暗黑模式 `#64748b`），底色在交互时激活为卡片纯白色，圆角 8px。
- **Focus:** 边框高亮切换为 `--ring`，呈现 3px 柔和外发光扩散，caret 光标呈现钴蓝色。
- **Error:** 边框切换为 Crimson Warning (`#9f1239`)，聚焦环呈现 20% 透明度红晕。

### Signature Component: Answer Sheet Item (`.answer-card-item`)
- **形态与排版**：正方形或适度紧凑的网格数字项，呈现等宽题号。
- **五态颜色契约**：
  - *未答（Unanswered/Rest）*：纸白底色，灰石边框（`#64748b`）。
  - *已答（Answered）*：浅蓝底色（`#dbeafe`），深蓝文字（`#1e40af`），蓝边（`#3b82f6`）。
  - *草稿/作答中（Draft）*：次级蓝背景（`#eff6ff`），钴蓝文字。
  - *正确（Correct）*：翠绿背景（`#ecfdf5`），深翠绿文字（`#065f46`），绿边。
  - *错误（Incorrect）*：柔粉背景（`#fff1f2`），深红文字（`#9f1239`），红边。
  - *待审阅/部分分（Pending）*：琥珀黄背景（`#fffbeb`），虚线边框（`border-style: dashed`）。
  - *当前题定位（Current Step）*：加粗 2px 蓝色双层聚焦圈。

### Badges
- **Style:** 胶囊形 Pill 轮廓，高度 `1.25rem` (20px)，字号 12px，内边距 `0.125rem 0.5rem`。

## Do's and Don'ts

### Do:
- **Do** 坚持 Flat-by-Default 原则：常规卡片、选项条目与题干区域使用 1px 边框建立边界，仅在浮层与弹窗中启用 `--overlay-shadow`。
- **Do** 对所有题目数字、答题倒计时、得分数据显式指定 `font-variant-numeric: tabular-nums`，确保排版绝无抖动。
- **Do** 为长篇材料题保留独立滚动的左侧分栏固定视窗，保证右侧作答与查题时上下文始终可见。
- **Do** 保证所有按钮与可交互元素在键盘 Tab 导航时均有清晰可见的 3px Focus Ring。
- **Do** 状态转换时间严格保持在 180ms，使用 `--motion-ease` (cubic-bezier(0.2, 0, 0, 1)) 平滑过渡。

### Don't:
- **Don't** 在界面中使用渐变文字、渐变背景或发光霓虹边框。
- **Don't** 将翠绿（Success）、琥珀（Warning）、绯红（Destructive）用于无语义的普通界面修饰。
- **Don't** 让做题核心界面的正文单行长度超过 80 字符，避免长篇阅读造成视线跳行疲劳。
- **Don't** 在深浅色主题切换时为单个控件添加错落的交错延迟动画；主题切换必须全局瞬时或通过整体视图淡入淡出（View Transitions）同步完成。
