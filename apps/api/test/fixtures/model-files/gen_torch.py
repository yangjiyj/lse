"""torch / numpy 样本。有 torch 用真实 torch.save；没有时按 torch zip 格式手工构造（note 注明）。"""
import io, pickle, zipfile
import numpy as np

try:
    import torch
except Exception:  # pragma: no cover
    torch = None


def _zip_add(data, name, payload):
    buf = io.BytesIO(data)
    with zipfile.ZipFile(buf, "a") as z:
        z.writestr(name, payload)
    return buf.getvalue()


def _torch_bytes(obj, legacy=False):
    buf = io.BytesIO()
    torch.save(obj, buf, _use_new_zipfile_serialization=not legacy)
    return buf.getvalue()


def _manual_state_dict_zip(storage):
    """无 torch 时：按 torch zip 布局构造 archive/data.pkl（_rebuild_tensor_v2 + persistent_load）。"""
    p = (b"\x80\x02}q\x00X\x06\x00\x00\x00weightq\x01ctorch._utils\n_rebuild_tensor_v2\nq\x02("
         b"(X\x07\x00\x00\x00storageq\x03ctorch\n" + storage.encode() + b"\nq\x04X\x01\x00\x00\x000q\x05"
         b"X\x03\x00\x00\x00cpuq\x06K\x04tq\x07QK\x00K\x04\x85K\x01\x85\x89ccollections\nOrderedDict\n)Rtq\x08Rq\x09s.")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("archive/data.pkl", p)
        z.writestr("archive/data/0", b"\x00" * 16)
        z.writestr("archive/version", b"3\n")
    return buf.getvalue()


def build(put, EVIL, BAD, CLEAN):
    if torch is not None:
        for dt, tag in ((torch.bfloat16, "bf16"), (torch.float16, "fp16"), (torch.float32, "fp32")):
            sd = {"layer.weight": torch.zeros(4, 4, dtype=dt), "layer.bias": torch.zeros(4, dtype=dt)}
            put(f"state_dict_{tag}.pt", _torch_bytes(sd), **CLEAN, format="pytorch-zip")
            put(f"state_dict_{tag}_legacy.bin", _torch_bytes(sd, legacy=True), **CLEAN, format="pickle")
        model = torch.nn.Sequential(torch.nn.Linear(2, 2), torch.nn.ReLU())
        put("full_module.pt", _torch_bytes(model), **CLEAN, format="pytorch-zip")
        good = _torch_bytes({"w": torch.zeros(2)})
        note = "torch.save " + torch.__version__
    else:
        for tag, st in (("bf16", "BFloat16Storage"), ("fp16", "HalfStorage"), ("fp32", "FloatStorage")):
            put(f"state_dict_{tag}.pt", _manual_state_dict_zip(st), **CLEAN, format="pytorch-zip",
                note="无 torch，按 torch zip 格式手工构造")
        good = _manual_state_dict_zip("FloatStorage")
        note = "手工构造"
    evil_pickle = pickle.dumps(EVIL, protocol=2)
    zpt = _zip_add(good, "archive/extra/evil.pickle", evil_pickle)
    put("zip_extra_evil.pt", zpt, **BAD, format="pytorch-zip", note=note)
    zdata = _zip_add(good, "archive/extra/hook.pkl", evil_pickle)
    put("zip_extra_hook.pth", zdata, **BAD, format="pytorch-zip", note=note)
    # config.json + metadata.json 不得把 pytorch zip 误路由到 Keras
    zk = _zip_add(_zip_add(zpt, "config.json", b"{}"), "metadata.json", b"{}")
    put("zip_keras_names_evil.pt", zk, **BAD, format="pytorch-zip")

    # numpy
    for name, arr in (("float32.npy", np.zeros((3, 3), dtype=np.float32)),):
        b = io.BytesIO(); np.save(b, arr); put(name, b.getvalue(), **CLEAN, format="numpy")
    b = io.BytesIO(); np.save(b, np.array([EVIL, 1], dtype=object), allow_pickle=True)
    put("object_evil.npy", b.getvalue(), **BAD, format="numpy")
    b = io.BytesIO(); np.save(b, np.array([{"a": 1}, "x"], dtype=object), allow_pickle=True)
    put("object_safe.npy", b.getvalue(), maxSeverity="LOW", format="numpy")
    b = io.BytesIO()
    np.savez(b, ok=np.zeros(2), evil=np.array([EVIL], dtype=object))
    put("mixed_evil.npz", b.getvalue(), **BAD, format="numpy")
    b = io.BytesIO(); np.savez_compressed(b, ok=np.zeros(8))
    put("safe_compressed.npz", b.getvalue(), **CLEAN, format="numpy")
