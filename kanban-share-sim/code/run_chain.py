# -*- coding: utf-8 -*-
"""
看板流水线 —— 冒烟测试桩 (stub)

用途：让 kanban-runner 在没有真实流水线代码的情况下做端到端自检。
模拟真实 run_chain.py 的行为：打印阶段标记、产出 output/ 中间产物、
生成 dashboard/dashboard_stub.html 看板。

只依赖 Python 标准库，无需安装任何第三方包。

用法：
    python run_chain.py                          # 直接跑（无数据文件）
    python run_chain.py --data C:\\tmp\\data.xlsx # 带数据文件
    python run_chain.py --skip-processing        # 跳过数据处理（无需 --data）
"""
import argparse
import os
import sys
import time
from datetime import datetime

# Windows 控制台/管道输出 UTF-8，避免中文乱码（py3.7+，低版本静默跳过）
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except (AttributeError, ValueError):
    pass

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def stage(marker: str) -> None:
    """打印运行器协议阶段标记（[STAGE n/total] 名称）。"""
    print(marker, flush=True)


def now_str(fmt: str = "%Y-%m-%d %H:%M:%S") -> str:
    return datetime.now().strftime(fmt)


def write_placeholder(out_dir: str, label: str) -> str:
    """在 out_dir 下写一个带时间戳的占位 txt，返回文件路径。"""
    os.makedirs(out_dir, exist_ok=True)
    name = "stub_%s_%s.txt" % (label, datetime.now().strftime("%Y%m%d_%H%M%S"))
    path = os.path.join(out_dir, name)
    with open(path, "w", encoding="utf-8") as f:
        f.write("stub placeholder: %s @ %s\n" % (label, now_str()))
    return path


def read_version() -> str:
    """读取同目录 version.txt，缺失时回退。"""
    vp = os.path.join(SCRIPT_DIR, "version.txt")
    try:
        with open(vp, "r", encoding="utf-8") as f:
            return f.read().strip() or "unknown"
    except OSError:
        return "unknown"


def main() -> int:
    parser = argparse.ArgumentParser(description="看板流水线冒烟测试桩")
    parser.add_argument("--data", help="要处理的 Excel 数据文件路径（可选）")
    parser.add_argument("--skip-processing", action="store_true",
                        help="跳过数据处理（不要求 --data）")
    args = parser.parse_args()

    data_name = None
    if args.data:
        data_name = os.path.basename(args.data)
        if not os.path.exists(args.data):
            print("ERROR: 数据文件不存在: %s" % args.data, flush=True)
            return 1
        print("收到数据文件: %s" % data_name, flush=True)
    elif args.skip_processing:
        print("已选择跳过数据处理", flush=True)
    else:
        print("未提供数据文件，以空数据模式运行", flush=True)

    print("冒烟桩启动 @ %s (version=%s)" % (now_str(), read_version()), flush=True)

    # ── 阶段 1/3：数据清洗 → silver ──
    stage("[STAGE 1/3] 数据清洗 silver")
    time.sleep(2)
    silver_file = write_placeholder(os.path.join(SCRIPT_DIR, "output", "silver"), "silver")

    # ── 阶段 2/3：汇总指标 → gold ──
    stage("[STAGE 2/3] 汇总指标 gold")
    time.sleep(2)
    gold_file = write_placeholder(os.path.join(SCRIPT_DIR, "output", "gold"), "gold")

    # ── 阶段 3/3：生成看板 ──
    stage("[STAGE 3/3] 生成看板")
    time.sleep(1)
    report_file = write_placeholder(os.path.join(SCRIPT_DIR, "output", "report"), "report")

    # ── 生成暗色极简看板页 ──
    dash_dir = os.path.join(SCRIPT_DIR, "dashboard")
    os.makedirs(dash_dir, exist_ok=True)
    dash_path = os.path.join(dash_dir, "dashboard_stub.html")
    html = _render_dashboard(data_name)
    with open(dash_path, "w", encoding="utf-8") as f:
        f.write(html)
    print("看板已生成: %s" % dash_path, flush=True)

    print("stub 流水线执行完成", flush=True)
    return 0


def _render_dashboard(data_name) -> str:
    """渲染暗色极简看板 HTML（纯内联样式，无外部资源）。"""
    version = read_version()
    gen_time = now_str()
    data_label = data_name or "（无数据文件 / 跳过处理）"
    return """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>冒烟测试看板</title>
<style>
  :root { color-scheme: dark; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0f1115; color: #e8eaed; font-family: "Microsoft YaHei", system-ui, sans-serif;
         min-height: 100vh; display: flex; flex-direction: column;
         align-items: center; justify-content: center; gap: 18px; text-align: center; }
  h1 { font-size: 34px; font-weight: 600; letter-spacing: 2px; }
  .badge { font-size: 13px; color: #9aa4b2; background: #1a1f29;
           border: 1px solid #2b3342; border-radius: 999px; padding: 4px 14px; }
  .row { font-size: 15px; color: #b9c0cc; }
  .row b { color: #e8eaed; }
  footer { margin-top: 28px; font-size: 12px; color: #5f6773; }
</style>
</head>
<body>
  <h1>冒烟测试看板</h1>
  <div class="badge">version %s</div>
  <div class="row">生成时间：<b>%s</b></div>
  <div class="row">数据文件：<b>%s</b></div>
  <footer>本页面由 run_chain.py 冒烟测试桩生成</footer>
</body>
</html>
""" % (version, gen_time, data_label)


if __name__ == "__main__":
    sys.exit(main())
