# 看板流水线 → 桌面应用方案评估

> 对象:D:\Files\projects\看板流水线(84 个 Python 文件 / 788KB,命令行销售分析流水线 → HTML 看板)
> 目标诉求:**做成一个应用,避免切换电脑的环境问题**(免装 Python、免 pip install)

## 一、先看清"环境问题"的本质

当前换电脑要做的事:装 Python → pip install -r requirements.txt(pandas/numpy/statsmodels/sklearn/matplotlib/rapidfuzz/chinese_calendar/calamine)→ 装好后跑命令行。

**关键事实:这一步只有 PyInstaller(或同类 Python 打包器)能解决。Tauri 本身解决不了 Python 环境——它只打包 Rust + 前端。** 所以无论选哪条路,Python 部分都必须走 PyInstaller,区别只是"谁来当壳"。

## 二、三个方案对比

### 方案 A:Tauri 全 Rust 重写 —— 不推荐 ✗

| 现有模块 | Rust 等价物 | 迁移成本 |
|---|---|---|
| 788KB 业务逻辑(规则引擎 46KB、产品画像 57KB、价格深潜 25KB…) | 全部重写 | **3~4 个月** |
| pandas 管道 | polars(API 语义不同) | 3~4 周 |
| statsmodels(趋势/预测) | statrs(弱,很多检验没有) | 2~3 周 |
| scikit-learn(IsolationForest 异常检测) | linfa/smartcore(弱) | 1~2 周 |
| rapidfuzz(客户名模糊匹配) | strsim 系(基本够用) | 3~5 天 |
| chinese_calendar(节假日) | 自移植节假日数据 | 2~3 天 |
| matplotlib 图表 | plotters / 或前端 ECharts | 1 周 |
| calamine 读 Excel | calamine(本来就是 Rust 库!) | 0 天 |

- 收益:安装包 ~30MB、启动 1~2s、内存低
- 代价:3~4 个月 + **全部销售分析结果要重新对照验证**(B2B 方法论规则、统计模型结果,业务正确性风险)
- 判断:788KB 的分析方法论是核心资产,Rust 统计生态弱,重写性价比极低

### 方案 B:纯 PyInstaller 打包 —— 立即解决环境问题 ✓ 推荐先做

run_chain.py + processing/ + dashboard/ + 依赖全家桶,经 PyInstaller onedir + Inno Setup 打包成「看板流水线.exe」,双击即用、免装 Python。

- 工作量:**2~5 天**(写 spec 文件 + 排除未用模块 + Inno Setup 脚本)
- 体积:约 500~700MB(pandas+numpy+sklearn+statsmodels 是硬成本,压缩后安装包 ~250MB)
- 启动:冷启动 10~20s(import 全家桶),处理耗时与现在相同(8~10 分钟)
- 体验升级(可选):拖 Excel 到 exe 上直接跑;或加极简 GUI(Gooey/PySide6 壳):选文件、进度条、完成弹窗

### 方案 C:Tauri 壳 + PyInstaller sidecar —— 体验最佳,体积最大 △

- Tauri 应用(安装包 ~300MB):
  - WebView2 前端:拖拽/选择 Excel、实时进度条(读 sidecar stdout)、**看板内嵌显示(直接复用 289KB 的 template.html + ECharts)**、历史看板管理
  - Rust 壳(15MB):spawn sidecar、文件对话框、窗口管理
  - Python sidecar:PyInstaller onedir 打包的整条流水线(~500MB)
- **独特优势:看板本来就是要浏览器打开的 HTML** —— Tauri 的 WebView2 天然内嵌显示,用户不用再"双击 HTML → 开浏览器";进度、报错、重跑都在一个界面里,对小白同事最友好
- 前端几乎零成本:289KB 的 template.html 直接放进 WebView 渲染
- 代价:体积 = Python 全家桶 + Tauri(比方案 B 略大);工程复杂度中等(sidecar 生命周期、stdout 解析)
- 工作量:1~2 周(方案 B 的基础上加壳)

## 三、针对你场景的推荐路线

你的用户是**不懂命令行的销售同事**,数据**内网敏感**,分发靠**拷贝文件夹**。据此:

1. **本周先做方案 B**(PyInstaller + Inno Setup):
   - 立刻消灭"装 Python / pip install"这个最大痛点
   - 双击安装包 → 双击 exe → 拖入 Excel → 出看板
   - 即使以后上 Tauri 壳,Python sidecar 的打包成果 100% 复用,零浪费
2. **观察两周**:同事会不会问"进度条在哪"、"怎么又要点浏览器"、"报错了看不懂"——如果这些反馈多,说明需要方案 C 的图形界面,再花 1~2 周加 Tauri 壳
3. **永远不做全 Rust 重写**:788KB 分析代码是你的护城河(B2B 方法论),不是负担

## 四、体积预期对比(诚实版)

| 方案 | 安装包 | 解包后 | 启动 | 工作量 | 环境问题 |
|---|---|---|---|---|---|
| 现状(装 Python) | 0 | 250MB 源码 | 30s+ | — | ✗ 每台电脑都要装 |
| A 全 Rust | ~30MB | ~60MB | 1~2s | 3~4 月 | ✓ |
| **B PyInstaller** | **~250MB** | ~600MB | 10~20s | **2~5 天** | ✓ |
| C Tauri+sidecar | ~300MB | ~650MB | 15~25s | 1~2 周 | ✓ |

注意:这个项目的体积大头是 Python 数据分析全家桶(pandas/numpy/sklearn/statsmodels),**任何保留 Python 内核的方案都躲不开**;Rust 重写虽能把体积压到 30MB,但成本是 3~4 个月 + 分析结果正确性再验证。对"内网拷贝分发、跑一次 8 分钟"的工具,250MB 安装包完全可接受——U 盘/共享盘都没压力。

## 五、结论

**你的核心诉求是"免环境",最快解是 PyInstaller,不是 Tauri。** Tauri 的价值在第二步:当同事们开始抱怨"黑窗口不友好"时,加一个 Tauri 壳(内嵌看板 + 进度条 + 图形交互),而那时 Python 内核的打包已经完成,加壳只需 1~2 周。

一句话:**先 PyInstaller 止血(2~5 天),再 Tauri 加壳提体验(1~2 周),别碰全 Rust 重写。**
