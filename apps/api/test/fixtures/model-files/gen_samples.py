#!/usr/bin/env python3
"""模型文件扫描回归样本生成器。

用法：python3 gen_samples.py <输出目录>
在输出目录生成全部样本与 manifest.json（每个样本的期望：必须命中的规则、允许的最高严重度、
HIGH 条数等）。测试运行时生成到临时目录，二进制样本不入库。
- 有 torch 时用真实 torch.save；没有时按 torch 格式手工构造（manifest 中 note 注明）。
- 生成过程中绝不反序列化任何恶意样本。
"""
import io, json, os, pickle, subprocess, sys, zipfile, zlib, ctypes, builtins
import gen_formats

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
MANIFEST = []


class R:
    """__reduce__ 载荷：加载时调用 f(*a)。"""

    def __init__(self, f, a):
        self.f, self.a = f, a

    def __reduce__(self):
        return (self.f, self.a)


def put(name, data, **expect):
    with open(os.path.join(OUT, name), "wb") as fh:
        fh.write(data)
    MANIFEST.append({"file": name, **expect})


EVIL = R(os.system, ("id",))
BAD = dict(maxSeverity="HIGH", minHigh=1, maxHigh=1)
CLEAN = dict(maxSeverity="LOW")  # 不得出现中危及以上

# 1) 各协议恶意 pickle
for proto in (0, 1, 2, 4, 5):
    put(f"p{proto}_os_system.pkl", pickle.dumps(EVIL, protocol=proto), **BAD, globalsInclude=["posix.system"])
put("p2_subprocess_popen.pkl", pickle.dumps(R(subprocess.Popen, (["id"],)), protocol=2), **BAD)
put("p4_builtins_eval.pkl", pickle.dumps(R(builtins.eval, ("1+1",)), protocol=4), **BAD)
put("p4_ctypes_cdll.pkl", pickle.dumps(R(ctypes.CDLL, ("libc.so.6",)), protocol=4), **BAD)
inner = pickle.dumps(EVIL, protocol=2)
put("p4_pickle_loads_nested.pkl", pickle.dumps(R(pickle.loads, (inner,)), protocol=4), **BAD)
put("p2_getattr_chain.pkl", b"\x80\x02cbuiltins\ngetattr\ncbuiltins\n__import__\nX\x02\x00\x00\x00os\x85RX\x06\x00\x00\x00system\x86RX\x02\x00\x00\x00id\x85R.", **BAD)

# 2) .bin 协议 0（首字节非 0x80）
put("proto0_payload.bin", pickle.dumps(EVIL, protocol=0), **BAD)

# 3) 多段 legacy：magic(proto2) + 协议 0 恶意段（第二段首字节非 0x80）
legacy = pickle.dumps(0x1950A86A20F9469CFC6C, protocol=2) + pickle.dumps(1001, protocol=2)
put("multi_legacy_evil.bin", legacy + pickle.dumps(EVIL, protocol=0), **BAD)
put("multi_legacy_third_seg.pt", legacy + pickle.dumps({"a": 1}, protocol=0) + pickle.dumps(EVIL, protocol=1), **BAD)

# 4) 安全的常见对象（不得报中危）
put("safe_ordered_dict.pkl", pickle.dumps({"k": [1, 2, 3]}, protocol=4), **CLEAN)
import argparse
put("safe_argparse_namespace.pkl", pickle.dumps({"args": argparse.Namespace(lr=0.1)}, protocol=2), **CLEAN)

# 5) 非白名单对象上的 REDUCE 升 HIGH（未知模块 + 调用）
fake = pickle.PROTO + b"\x02" + b"cevil_pkg.loader\nrun\n" + b"X\x02\x00\x00\x00id\x85R."
put("unknown_reduce.pkl", fake, maxSeverity="HIGH", minHigh=1, rules=["PICKLE_UNSAFE_CALL"])
put("unknown_global_only.pkl", pickle.PROTO + b"\x02cevil_pkg.loader\nConfig\n.", maxSeverity="MEDIUM", maxHigh=0)

# 6) joblib 风格 zlib 压缩（joblib 未安装：以 zlib.compress(pickle) 模拟 joblib compress='zlib' 的帧格式）
put("evil_zlib.joblib", zlib.compress(pickle.dumps(EVIL, protocol=4)), **BAD, note="模拟 joblib zlib 压缩")

# 7) torch / numpy 相关
import gen_torch
gen_torch.build(put, EVIL, BAD, CLEAN)

# 8) safetensors / GGUF
gen_formats.build(put, os.path.dirname(os.path.abspath(__file__)))

with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as fh:
    json.dump(MANIFEST, fh, ensure_ascii=False, indent=1)
print(f"generated {len(MANIFEST)} samples into {OUT}")
