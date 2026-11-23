"""safetensors 与 GGUF 样本（struct 手写）。GGUF 负例用 templates/ 下取自官方仓库的真实 chat_template：
- qwen2.5-3b-instruct.jinja   ← modelscope.cn/models/Qwen/Qwen2.5-3B-Instruct tokenizer_config.json（sha256 5b5d4f65…9583）
- llama3-8b-instruct.jinja    ← modelscope.cn/models/LLM-Research/Meta-Llama-3-8B-Instruct（sha256 da0e3a7c…75bb）
- llama3.1-8b-instruct.jinja  ← modelscope.cn/models/LLM-Research/Meta-Llama-3.1-8B-Instruct（sha256 177c7b61…d424）
（取 chat_template 字段原文，未改动）
"""
import json, os, struct


def _st(header, data_len):
    h = json.dumps(header).encode()
    return struct.pack("<Q", len(h)) + h + b"\x00" * data_len


def _gs(s):
    b = s.encode("utf-8")
    return struct.pack("<Q", len(b)) + b


def _gguf(kv):
    out = [b"GGUF", struct.pack("<I", 3), struct.pack("<Q", 0), struct.pack("<Q", len(kv))]
    for k, v in kv:
        out.append(_gs(k))
        if isinstance(v, str):
            out += [struct.pack("<I", 8), _gs(v)]
        else:
            out += [struct.pack("<I", 4), struct.pack("<I", v)]
    return b"".join(out)


def build(put, here):
    ok = {"__metadata__": {"format": "pt", "license": "apache-2.0"},
          "w": {"dtype": "BF16", "shape": [2, 2], "data_offsets": [0, 8]},
          "b": {"dtype": "F32", "shape": [2], "data_offsets": [8, 16]}}
    put("ok.safetensors", _st(ok, 16), maxSeverity="INFO", rules=["SAFETENSORS_VALIDATED"], format="safetensors")
    oob = {"w": {"dtype": "F32", "shape": [4], "data_offsets": [0, 64]}}
    put("oob.safetensors", _st(oob, 16), maxSeverity="HIGH", rules=["SAFETENSORS_INVALID"], format="safetensors")
    bad_dtype = {"w": {"dtype": "OBJ", "shape": [2], "data_offsets": [0, 8]}}
    put("bad_dtype.safetensors", _st(bad_dtype, 8), maxSeverity="HIGH", rules=["SAFETENSORS_INVALID"], format="safetensors")
    size_mismatch = {"w": {"dtype": "F32", "shape": [3], "data_offsets": [0, 8]}}
    put("size_mismatch.safetensors", _st(size_mismatch, 8), maxSeverity="HIGH", rules=["SAFETENSORS_INVALID"], format="safetensors")

    tdir = os.path.join(here, "templates")
    for fn in sorted(os.listdir(tdir)):
        tpl = open(os.path.join(tdir, fn), encoding="utf-8").read()
        kv = [("general.architecture", "llama"), ("general.license", "apache-2.0"),
              ("general.source.url", "https://www.modelscope.cn/models/example"),
              ("tokenizer.chat_template", tpl)]
        put(f"real_{fn.replace('.jinja', '')}.gguf", _gguf(kv), maxSeverity="INFO", format="gguf")
    ns = ("{%- set ns = namespace(found=false) -%}{%- for m in messages -%}{%- if m.role == 'system' -%}"
          "{%- set ns.found = true -%}{%- endif -%}{{ m.content }} see https://example.com/docs{%- endfor -%}")
    put("namespace_url.gguf", _gguf([("tokenizer.chat_template", ns)]), maxSeverity="INFO", format="gguf")
    ssti = [
        ("ssti_mro.gguf", "{{ ''.__class__.__mro__[1].__subclasses__() }}"),
        ("ssti_globals.gguf", "{{ cycler.__init__.__globals__.os.popen('id').read() }}"),
        ("ssti_attr.gguf", "{{ ()|attr('\\x5f\\x5fclass\\x5f\\x5f') }}"),
        ("ssti_attr_underscore.gguf", "{{ x|attr('_TemplateReference__context') }}"),
    ]
    for fn, t in ssti:
        put(fn, _gguf([("tokenizer.chat_template", t)]), maxSeverity="HIGH", rules=["GGUF_TEMPLATE_SSTI"], format="gguf")
