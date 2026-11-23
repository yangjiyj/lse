# Nuclei 固定输出夹具

- 引擎源码：ProjectDiscovery Nuclei `v3.9.0`
- tag commit：`ffbb05b254b3d11d985c486d9512c25bd0fa56be`
- 本次构建二进制 SHA-256：`49e51f7c3ca2b8ed68b54295e91934be79caa69b677535e4d23d366d3868e4cb`
- 采集日期：`2026-08-30`
- 采集目标：仅 `127.0.0.1:18731` 和 `127.0.0.1:18732` 受控临时 HTTP 服务
- 运行参数：`-duc -silent -jsonl -omit-template -include-rr`

`nuclei-safe-negative.jsonl` 是对固定 404 服务运行配置模板得到的真实空输出。
业务测试必须把空输出解释为“未命中”，不得制造组件或风险。
