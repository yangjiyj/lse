"""把平台中文题库种子包装成 garak 自定义 probe（纯 stdlib，可在宿主机直接单测）。

背景：garak 的价值是它自带的标准探针库；它的 CLI 以 --probes 选固定 probe 族，
不直接吃任意自定义 prompt。本模块按 garak 的「自定义 probe 插件」约定，把平台传入的
prompt_seeds 生成一个 probe 模块（一个 Probe 子类，prompts=种子列表），写进 garak 的
probes 包目录后即可用 --probes <module>.<Class> 引用。

⚠️ 诚实边界：garak Probe 基类的属性名随版本变化（bcp47/lang、primary_detector/
recommended_detector），且本仓库未部署 garak（torch 重镜像 + Docker Hub 被墙），
所以「真实 garak 能否加载本 probe」未经端到端验证。app.py 侧对整条注入做了 try/except
回退：自定义 probe 不可用时静默回退标准 probe，绝不因此中断扫描。
本模块的【生成逻辑】可在宿主机用 test_seed_probe.py 完整单测（无需 garak/torch）。
"""
from __future__ import annotations

import json
import os
from typing import Optional

SEED_PROBE_MODULE = "lse_seed_probe"
SEED_PROBE_CLASS = "LseSeedProbe"
SEED_PROBE_SPEC = f"{SEED_PROBE_MODULE}.{SEED_PROBE_CLASS}"


def clean_seeds(seeds: Optional[list[str]]) -> list[str]:
    """过滤出非空字符串种子，保序去重。"""
    out: list[str] = []
    seen: set[str] = set()
    for s in seeds or []:
        if isinstance(s, str) and s.strip():
            v = s.strip()
            if v not in seen:
                seen.add(v)
                out.append(v)
    return out


def build_seed_probe_module(seeds: list[str]) -> str:
    """生成 garak 自定义 probe 模块源码（用 json 安全嵌入中文/转义）。"""
    prompts_literal = json.dumps(clean_seeds(seeds), ensure_ascii=False)
    return (
        '"""自动生成：平台题库种子 → garak 自定义 probe。属性名为兼容多版本写法。"""\n'
        "from garak.probes.base import Probe\n"
        "\n"
        "\n"
        f"class {SEED_PROBE_CLASS}(Probe):\n"
        '    bcp47 = "*"\n'
        '    lang = "*"\n'
        '    primary_detector = "mitigation.MitigationBypass"\n'
        '    recommended_detector = ["mitigation.MitigationBypass"]\n'
        '    tags = ["lse:seed"]\n'
        '    goal = "elicit unsafe content using platform-provided seed prompts"\n'
        "\n"
        "    def __init__(self, config_root=None):\n"
        "        try:\n"
        "            super().__init__(config_root=config_root)\n"
        "        except TypeError:\n"
        "            super().__init__()\n"
        f"        self.prompts = {prompts_literal}\n"
    )


def prepare_seed_probe(seeds: Optional[list[str]], dest_dir: str) -> Optional[str]:
    """把种子写成 probe 模块到 dest_dir；无有效种子返回 None，否则返回 --probes 规格名。

    dest_dir 应为 garak.probes 包目录，使 --probes lse_seed_probe.LseSeedProbe 可解析。
    """
    cleaned = clean_seeds(seeds)
    if not cleaned:
        return None
    path = os.path.join(dest_dir, f"{SEED_PROBE_MODULE}.py")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(build_seed_probe_module(cleaned))
    return SEED_PROBE_SPEC
