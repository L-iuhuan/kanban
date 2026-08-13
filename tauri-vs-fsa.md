# Tauri 适配性评估:财务报表自动稽核系统 (FSA)

> 评估对象:D:\Files\projects\财务报表自动稽核 (Python 3.11 + PySide6 离线桌面软件)
> 评估日期:2026-08

## 一、项目画像

| 维度 | 现状 |
|---|---|
| 定位 | 离线、开源、CAS 专用、确定性规则驱动的财务报表勾稽校验桌面软件 |
| GUI | PySide6 + qfluentwidgets (Fluent 风格,约 15 个页面/组件,~150KB 代码) |
| 数据层 | pandas + openpyxl/xlrd + pdfplumber(财务数据处理黄金组合) |
| 规则引擎 | 自研 AST DSL (simpleeval),37 条 CAS 勾稽规则已实现 |
| Agent | Ollama 本地 LLM 诊断(财务数据敏感必须离线) |
| 企业集成 | pywin32 COM(DLP 加密环境回退通道) |
| 代码规模 | 79 个源文件 474KB + 78 个测试文件 477KB(接近 1:1) |
| 工程质量 | pytest 覆盖率门槛 90%、mypy strict、ruff、TEST_PLAN/CODE_REVIEW 齐全 |
| 打包 | PyInstaller onedir + Inno Setup(installer.iss 已备) |

## 二、体积/性能预估对比

| 指标 | FSA 现状 (PySide6 方案) | 全迁 Tauri 后 | 差距 |
|---|---|---|---|
| 安装包 | 预计 120~250MB(PySide6 ~150MB + pandas/numpy ~80MB + Qt 插件) | 15~40MB | 5~10× |
| 解包体积 | 预计 300~500MB | 20~60MB | ~8× |
| 冷启动 | 3~8s(Python 解释器 + Qt 加载 + pandas import) | 1~2s | 3~4× |
| 常驻内存 | 200~400MB(Qt 渲染 + pandas 数据) | 80~150MB | 2~3× |
| 大 Excel 读取 | pandas/openpyxl(纯 Python,100MB 报表可能 10~30s) | calamine 原生解析(可快 5~10×) | **性能是真实收益点** |

## 三、逐模块迁移成本(核心问题所在)

| FSA 模块 | 现有实现 | Tauri/Rust 替代 | 迁移成本 |
|---|---|---|---|
| **数据管道(importer/engine/exporter)** | pandas DataFrame 全链路 | polars(API 不同,财务语义重写) | **3~5 周,最大头** |
| **37 条 CAS 规则 + AST DSL** | simpleeval + 规则 JSON | Rust 表达式求值重写 + 规则移植 | 2~3 周 + **金融正确性再验证** |
| Excel 读写 | openpyxl/xlrd | calamine + rust_xlsxwriter | 1 周 |
| PDF 导入(V1 规划) | pdfplumber/Camelot | lopdf + 自研表格抽取 | 2~3 周(表格抽取很难) |
| GUI 15+ 页面 | PySide6 组件 | Web 前端全重写 | 3~4 周 |
| Ollama Agent | Python client + tools | reqwest 重写 + tool 移植 | 1 周 |
| pywin32 COM(DLP 通道) | COM 调用 | windows crate 重写 | 3~5 天 |
| SQLite 存储 | sqlite3 标准库 | rusqlite | 2~3 天 |
| **477KB 测试套件** | pytest | 全部重写(cargo test) | **2~3 周,正确性保障** |
| **合计** | | | **约 3~4 个月**(单 Rust 熟练者) |

**致命点:这个项目的资产不是 UI,是"规则 + 数据管道 + 测试"。**
- 37 条 CAS 规则已经写好、测过、mypy strict 过 —— 金融场景重写一遍 = 重新承担一遍规则理解错误的风险
- 477KB 测试(覆盖率 90% 门槛)是正确性的护城河,Rust 重写意味着护城河重建
- pandas 在财务数据处理上无可替代(Rust 的 polars 是分析型 API,openpyxl 级别的财务格式化读写生态没有)

## 四、三个可选路线

### 路线 A:全迁 Tauri —— 不推荐
- 成本:3~4 个月 + 金融规则正确性风险
- 收益:体积 5~10×、启动 3~4×、内存 2~3×
- 判断:对一个 **离线、低频交互、单据型** 的审计工具,体积/启动不是用户的核心痛点;正确性和开发速度才是。**收益配不上成本。**

### 路线 B:混合 —— PyO3 借 Rust 之力(务实推荐)⭐
GUI 和 pandas 管道全不动,只把**性能敏感点**抽出来用 Rust 加速,通过 PyO3 暴露给 Python:

| 加速点 | 现状 | PyO3 后 |
|---|---|---|
| 大 Excel 解析(100MB 报表) | openpyxl 10~30s | calamine 原生,预计 3~5s |
| 科目名称模糊匹配(name_mapper.py 12.8KB) | Python 字符串循环 | Rust 一遍过,快 10× |
| 规则批量执行(37 条 × N 科目) | simpleeval 解释执行 | Rust 编译求值 |
| PDF 表格抽取(V1) | pdfplumber 慢 | lopdf/自研,更快更稳 |

- 成本:每点 2~5 天,总量 2~3 周
- 收益:拿到 Tauri 方案中唯一实质性的优势(**大文件性能**),零正确性风险(测试套件照跑)
- 打包体积几乎不变,但体积本来就不是这项目的主要矛盾

### 路线 C:保持 Python,优化分发 —— 最省事
- PyInstaller 精简(excludes 掉 Qt 未用模块,onedir 通常能压到 150~200MB)
- 或 Nuitka 编译(启动提速 30~50%,体积略降)
- 或换轻量 GUI 方案(如 pywebview + 前端,Python 后端不动,体积和 PySide6 相近但 UI 可复用 Web 生态)

## 五、结论

**FSA 不适合迁 Tauri,和 docflow 的评估结论正好相反:**

| 判据 | docflow (Electron OCR) | FSA (PySide6 稽核) |
|---|---|---|
| 前端资产 | React 90% 可平移 | PySide6 全重写 |
| 后端资产 | Node task worker(一般) | pandas 管道 + 规则引擎(核心) |
| 正确性包袱 | 无(OCR 结果人工复核) | **高(金融勾稽,测试护城河)** |
| 体积痛感 | 高(云上传工具,分发频繁) | 低(离线内网分发一次装完) |
| 性能瓶颈 | 有(批处理并发) | 局部(大 Excel 解析) |
| **结论** | **值得迁** | **不迁,最多 PyO3 局部加速** |

一句话:**docflow 的痛点在"壳"(Electron 太肥),FSA 的资产在"核"(Python 数据/规则生态),壳可以换,核不能扔。**

如果 FSA 后续真的出现"安装包体积被客户吐槽"或"大报表解析太慢"这两个具体痛点,优先走路线 B(PyO3 加速),而不是整体迁移。
