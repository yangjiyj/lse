#!/usr/bin/env python3
"""模型识别夹具：在输出目录造几类小模型目录（只有头部和极少的张量数据），供识别结论测试用。

用法：python3 gen_identify.py <输出目录>
- q4/      GGUF，general.file_type=15（Q4_K_M）→ 量化
- f16/     GGUF，general.file_type=1（F16）→ 未识别（查不到、也没有改动痕迹）
- awq/     safetensors + config.json（quantization_config.quant_method=awq, bits=4）→ 量化
- fp8/     safetensors + config.json（quant_method=fp8）→ 量化
- fp8mix/  safetensors 含 F8 权重张量，config.json 没写量化配置 → 量化（FP8）
- lora/    adapter_model.safetensors + adapter_config.json（LoRA r=8）→ 适配器
- plain/   safetensors + config.json（无量化）→ 未识别
- merged/  safetensors + config.json + mergekit_config.yml → 合并
- ft/      safetensors + config.json + training_args.bin → 微调
"""
import json, os, pickle, sys
from gen_formats import _gguf, _st

OUT = sys.argv[1]


def put(rel, data):
    path = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data if isinstance(data, bytes) else data.encode("utf-8"))


def cfg(**extra):
    base = {"architectures": ["LlamaForCausalLM"], "model_type": "llama", "torch_dtype": "bfloat16",
            "hidden_size": 8, "num_hidden_layers": 1}
    base.update(extra)
    return json.dumps(base, indent=2)


put("q4/demo-7b-q4_k_m.gguf", _gguf([("general.architecture", "llama"), ("general.name", "Demo-7B"),
                                     ("general.file_type", 15)]))
put("f16/demo-7b-f16.gguf", _gguf([("general.architecture", "llama"), ("general.name", "Demo-7B"),
                                   ("general.file_type", 1)]))

put("awq/model.safetensors", _st({"model.layers.0.self_attn.q_proj.qweight":
                                  {"dtype": "I32", "shape": [2, 2], "data_offsets": [0, 16]}}, 16))
put("awq/config.json", cfg(architectures=["Qwen2ForCausalLM"], model_type="qwen2", torch_dtype="float16",
                           quantization_config={"quant_method": "awq", "bits": 4, "group_size": 128}))

put("fp8/model.safetensors", _st({"w": {"dtype": "F8_E4M3", "shape": [4], "data_offsets": [0, 4]}}, 4))
put("fp8/config.json", cfg(quantization_config={"quant_method": "fp8", "activation_scheme": "dynamic"}))

put("lora/adapter_model.safetensors",
    _st({"base_model.model.model.layers.0.self_attn.q_proj.lora_A.weight":
         {"dtype": "F32", "shape": [2, 2], "data_offsets": [0, 16]}}, 16))
put("lora/adapter_config.json", json.dumps({
    "peft_type": "LORA", "task_type": "CAUSAL_LM", "r": 8, "lora_alpha": 16, "lora_dropout": 0.05,
    "target_modules": ["q_proj", "v_proj"], "base_model_name_or_path": "Qwen/Qwen2.5-7B-Instruct"}, indent=2))

# 真实 FP8 权重（Qwen3-8B-FP8 第一个分片：BF16 216 个、F8_E4M3 137 个）：线性层权重是 F8，
# 归一化、嵌入和 weight_scale_inv 是 BF16；config.json 没写 quantization_config 时也要认出 FP8
put("fp8mix/model.safetensors", _st({
    "model.embed_tokens.weight": {"dtype": "BF16", "shape": [2], "data_offsets": [0, 4]},
    "model.layers.0.input_layernorm.weight": {"dtype": "BF16", "shape": [2], "data_offsets": [4, 8]},
    "model.layers.0.mlp.down_proj.weight": {"dtype": "F8_E4M3", "shape": [4], "data_offsets": [8, 12]},
    "model.layers.0.mlp.down_proj.weight_scale_inv": {"dtype": "BF16", "shape": [1], "data_offsets": [12, 14]},
    "model.layers.0.self_attn.q_proj.weight": {"dtype": "F8_E4M3", "shape": [4], "data_offsets": [14, 18]},
}, 18))
put("fp8mix/config.json", cfg(architectures=["Qwen3ForCausalLM"], model_type="qwen3"))

put("plain/model.safetensors", _st({"w": {"dtype": "BF16", "shape": [2, 2], "data_offsets": [0, 8]}}, 8))
put("plain/config.json", cfg())

put("merged/model.safetensors", _st({"w": {"dtype": "BF16", "shape": [2], "data_offsets": [0, 4]}}, 4))
put("merged/config.json", cfg())
put("merged/mergekit_config.yml", "merge_method: slerp\nbase_model: org/a\nslices:\n  - sources:\n      - model: org/a\n      - model: org/b\n")

put("ft/model.safetensors", _st({"w": {"dtype": "BF16", "shape": [2], "data_offsets": [0, 4]}}, 4))
put("ft/config.json", cfg(_name_or_path="Qwen/Qwen2.5-7B"))
put("ft/training_args.bin", pickle.dumps({"learning_rate": 2e-5, "num_train_epochs": 3}, protocol=4))
print(f"generated identify fixtures into {OUT}")
