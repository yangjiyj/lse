# 语料扫描：敏感信息规则与来源

语料扫描（需求 1.2.2）的敏感信息类别和写法对齐 JJDGuard 安全引擎。规则代码在
`apps/api/src/modules/corpus-scans/core/sensitive-rules.ts`，服务端扫描、打码副本和命令行版共用。

来源对照只记在本文档里：检测核心会原样打进给客户的命令行版 tar 包，代码里不写参考产品名、源码路径和来源文件名
（`corpus-cli.test.ts` 的打包测试会检查 tar 包里没有 `/home/` 和参考产品名）。

- 参考来源：JJDGuard 安全引擎 2026-11-21 版本的规则，下表的「来源文件」是其源码仓库内的相对路径。
- 一段原文只记一类：规则按下表顺序匹配，先命中的类别占住这段原文，后面的类别不再重复记。
  带标签的证件号（驾驶证、社保卡）排在通用身份证号前面，通信记录、银行流水这类整段规则排在手机号、银行卡号前面。
- 命中原文不打码（客户要求）。打码副本把命中的值换成 `[类型名称]`，跨行的命中（私钥块）保留原有换行，行数不变。

## 类别清单（40 类）

| 序号 | 类别 | 名称 | 严重度 | 来源文件 | 校验与佐证 |
|---|---|---|---|---|---|
| 1 | `private_key` | 私钥 | CRITICAL | `apps/security-engine/app/detectors/engine.py`（`ssh_private_key`、`openssh_private_key`） | 匹配 `BEGIN … PRIVATE KEY` 到 `END` 整块，没有 END 时只记开头 |
| 2 | `database_url` | 数据库连接串 | CRITICAL | `apps/security-engine/app/detectors/data_leak.py`（`database_url`）、`config_evidence.py`（`credential_url_has_literal`） | 连接串里要有字面口令（userinfo 或 query 的 password 等），`${VAR}` 等变量引用不算 |
| 3 | `aws_access_key` | AWS 访问密钥 ID | CRITICAL | `apps/security-engine/app/detectors/engine.py`（`aws_access_key`） | 排除官方示例 `AKIAIOSFODNN7EXAMPLE` |
| 4 | `aws_secret_key` | AWS 秘密访问密钥 | CRITICAL | `apps/security-engine/app/detectors/engine.py`（`aws_secret_key`、`AWS_SECRET_KEY_CONTEXT`） | 前后 80 字内要有 `aws_secret_access_key` 一类字段名 |
| 5 | `cloud_credential` | 云凭据 | CRITICAL | `apps/security-engine/app/detectors/sensitive_data.py`（`cloud_credential`） | 值 ≥ 16 位、非占位、熵 ≥ 3 |
| 6 | `anthropic_key` | Anthropic 密钥 | CRITICAL | `apps/security-engine/app/detectors/engine.py`（`anthropic_key`、`_is_placeholder_secret`） | 排除 `sk-ant-xxx` 一类示例 |
| 7 | `openai_key` | OpenAI 密钥 | CRITICAL | `apps/security-engine/app/detectors/engine.py`（`openai_key`、`_is_placeholder_secret`） | 排除 `sk-your-api-key` 一类示例 |
| 8 | `github_token` | GitHub 令牌 | CRITICAL | `apps/security-engine/app/detectors/engine.py`（`github_token`） | — |
| 9 | `jwt_token` | JWT 令牌 | HIGH | `apps/security-engine/app/detectors/engine.py`（`jwt_token`） | 三段 base64url |
| 10 | `generic_api_key` | API 密钥 | HIGH | `apps/security-engine/app/detectors/engine.py`（`generic_api_key`、`_is_credible_generic_secret`）、`data_leak.py`（`api_key_leak`） | 值 ≥ 16 位、熵 ≥ 3.2，排除全大写常量名和占位 |
| 11 | `access_key` | 访问密钥 | CRITICAL | `apps/security-engine/app/detectors/data_leak.py`（`access_key`） | 引号里的字面值，排除占位和变量引用 |
| 12 | `token_leak` | 令牌 | HIGH | `apps/security-engine/app/detectors/data_leak.py`（`token_leak`） | 同上 |
| 13 | `login_credential` | 登录凭据 | HIGH | 本线补充 | 「用户名/账号 + 密码/口令」成对出现，口令 ≥ 3 位、非占位；对应需求 1.2.2「用户名与密码」 |
| 14 | `plain_password` | 明文密码 | CRITICAL | `apps/security-engine/app/detectors/sensitive_data.py`（`plain_password`、`_credible_password`） | ≥ 10 位、至少三类字符、熵 ≥ 3 |
| 15 | `password_in_code` | 密码 | CRITICAL | `apps/security-engine/app/detectors/data_leak.py`（`password_in_code`） | 引号值 ≥ 4 位、裸值 ≥ 8 位，非占位、不含中文；本线补了中文标签「密码」「口令」 |
| 16 | `driver_license_cn` | 驾驶证号 | HIGH | `apps/security-engine/app/detectors/sensitive_data.py`（`driver_license_cn`） | 18 位按身份证校验，或 12 位档案号 |
| 17 | `social_security_cn` | 社会保障号 | HIGH | `apps/security-engine/app/detectors/sensitive_data.py`（`social_security_cn`） | 18 位数字形式按身份证校验 |
| 18 | `passport_cn` | 护照号 | HIGH | `apps/security-engine/app/detectors/sensitive_data.py`（带标签）、`deploy/migrations/133_fix_passport_regex_escaping.sql`（通用规则 `rule_g_passport`） | 通用写法前面 24 字内没有「护照」「passport」时降为 LOW（`D20231201` 这类单据号） |
| 19 | `hk_macao_taiwan_id` | 港澳台证件号 | HIGH | `apps/security-engine/app/detectors/sensitive_data.py`（`hk_macao_taiwan_id`） | 要有证件标签 |
| 20 | `officer_id_cn` | 军官证/警官证号 | HIGH | `apps/security-engine/app/detectors/sensitive_data.py`（`officer_id_cn`） | 要有证件标签 |
| 21 | `home_address_cn` | 家庭住址 | HIGH | `apps/security-engine/app/detectors/sensitive_data.py`（`home_address_cn`、`_valid_home_address`） | 要有门牌要素和行政区划；「服务器地址」「IP 地址」不算 |
| 22 | `ip_address` | IP 地址 | MEDIUM | `apps/security-engine/app/detectors/sensitive_data.py`（`_detect_ip_addresses`） | 要有客户端、登录等标签；每段 ≤ 255，排除 0.0.0.0 和组播 |
| 23 | `birth_date` | 出生日期 | MEDIUM | `apps/security-engine/app/detectors/sensitive_data.py`（`birth_date`） | 日期真实存在，1900 年以后、不晚于今天 |
| 24 | `gps_location` | GPS 位置 | HIGH | `apps/security-engine/app/detectors/sensitive_data.py`（`_detect_gps`） | 纬度 ±90、经度 ±180 |
| 25 | `communication_record` | 通信记录 | HIGH | `apps/security-engine/app/detectors/sensitive_data.py`（`communication_record`） | 内容里要有号码、时间、通话时长等佐证 |
| 26 | `credit_card_cvv` | 信用卡安全码 | CRITICAL | `apps/security-engine/app/detectors/sensitive_data.py`（`credit_card_cvv`） | `CID` 开头的要在前后 160 字内有有效卡号 |
| 27 | `bank_statement` | 银行流水 | HIGH | `apps/security-engine/app/detectors/sensitive_data.py`（`bank_statement`） | 交易、金额、账户、日期四类佐证至少两类 |
| 28 | `insurance_info` | 保单信息 | HIGH | `apps/security-engine/app/detectors/sensitive_data.py`（`insurance_info`） | 只取单号本身（JJDGuard 原规则会带上后面 80 字，这里不带，打码更准） |
| 29 | `medical_record` | 病历信息 | HIGH | `apps/security-engine/app/detectors/sensitive_data.py`（`medical_record`） | 附近要同时有就诊和诊疗两类词 |
| 30 | `genetic_data` | 基因数据 | HIGH | `apps/security-engine/app/detectors/sensitive_data.py`（`genetic_data`） | ≥ 20 个碱基、至少三种 |
| 31 | `biometric_data` | 生物识别数据 | HIGH | `apps/security-engine/app/detectors/sensitive_data.py`（`biometric_data`） | 值 ≥ 16 位、熵 ≥ 3 |
| 32 | `internal_project_code` | 内部项目代号 | HIGH | `apps/security-engine/app/detectors/sensitive_data.py`（`internal_project_code`） | 代号里要有数字、下划线或连字符 |
| 33 | `sensitive_code` | 敏感代码 | HIGH | `apps/security-engine/app/detectors/sensitive_data.py`（`sensitive_code`） | 内容要像代码 |
| 34 | `education_background` | 教育背景 | MEDIUM | `apps/security-engine/app/detectors/sensitive_data.py`（`education_background`） | 要有院校或学历词 |
| 35 | `criminal_record` | 犯罪记录 | HIGH | `apps/security-engine/app/detectors/sensitive_data.py`（`criminal_record`） | 要有罪名、判处等词 |
| 36 | `id_card_cn` | 身份证号 | HIGH | `apps/security-engine/app/detectors/engine.py`（`id_card_cn`）、`pii_checksum.py`（`validate_id_card_cn`）、`pii_variants.py`（分组写法） | GB 11643 校验位、省级区划、出生日期真实且不晚于今天；支持 6-8-4、6-4-4-4 分组 |
| 37 | `bank_card_cn` | 银行卡号 | HIGH | `apps/security-engine/app/detectors/engine.py`（`bank_card_cn`）、`pii_checksum.py`（`validate_bank_card`）、`pii_variants.py`（分组写法） | 首位 3–6、Luhn；4-4-4-4 分组写法要有卡号类上下文或是 62 开头 19 位 |
| 38 | `phone_cn` | 手机号 | MEDIUM | `apps/security-engine/app/detectors/engine.py`（`phone_cn`）、`pii_checksum.py`（`validate_phone_cn_segment`）、`pii_variants.py`（3-4-4 分组、+86） | 只认已放号号段 |
| 39 | `email` | 电子邮箱 | LOW | `apps/security-engine/app/detectors/engine.py`（`email`）、`sensitive_data.py`（`is_non_mailbox_at_reference`） | 排除「包名@版本号」和 openssh 协议扩展名 |
| 40 | `uscc` | 统一社会信用代码 | MEDIUM | `deploy/migrations/068_industry_data_security_packs.sql`（`rule_f_uscc`） | 本线补了 GB 32100 校验位（JJDGuard 只有形状正则）；前面 24 字内没有「统一社会信用代码」「税号」「营业执照」等标签词时降为 LOW |

占位值判断（`isPlaceholder`）合并了 `sensitive_data.py` 的 `PLACEHOLDER_VALUE`、`config_evidence.py` 的 `_PLACEHOLDER` 和 `_REFERENCE_VALUE`，
本线另加 `your_`、`example-` 这类前缀、整串同一个字符（`******`）和 `null`、`true` 这类代码字面量。

## 误报过滤

对照 JJDGuard `engine.py` 的 `_filter_invalid_builtin_rule_pii`（内置通用 PII 规则的确定性过滤），移植了其中三个过滤，
代码在 `sensitive-rules.ts` 的 `binaryRegions`、`nonPiiNumericSpans`、`isUrlUserinfo`，`findSensitive` 里按类型套用：

| 过滤 | JJDGuard 来源 | 作用于 | 这里的写法 |
|---|---|---|---|
| 二进制编码块 | `encoded_content.py` 的 `binary_regions` | 手机号、银行卡号、身份证号、邮箱、护照号（对应 `rule_g_phone`、`rule_g_bankcard`、`rule_g_idcard`、`rule_g_email`、`rule_g_passport`） | ≥ 256 字、长度是 4 的倍数的 base64 串，解开前 128 字是 PNG、JPEG、GIF、WEBP、WAVE、TIFF、PDF、ZIP、GZIP 文件头的，整段落在里面的命中不算 |
| 不是个人信息的数字 | `numeric_context.py` 的 `non_pii_numeric_spans` | 手机号、银行卡号（对应 `rule_g_phone`、`rule_g_bankcard`） | 与下面三种数字段整段重合的命中不算：小数的 11～19 位小数部分（前面不能紧贴字母数字或点）；含字母或下划线的 ASCII 标识符里 11～19 位的数字串（`img_13800138000.png`、`u4111111111111111`）；`swap` 表格的 SIZE、USED 列。中文标签紧贴的号码（`电话13800138000`）照样认 |
| URL 里的 userinfo | `numeric_context.py` 的 `is_url_userinfo` | 邮箱（对应 `rule_g_email`） | 命中前 512 字内是 `scheme://` 加不含空白、`/?#@` 的 authority 前缀时，`user@host` 是 URL 的一部分，不是邮箱 |

JJDGuard 同一处还有手机号号段、`\n@pytest` 这类转义序列、校验位开关下的身份证和银行卡校验：号段和校验位这里在规则的
`validate` 里已经做了；转义序列在 JSON 语料里解析后就不存在，没有移植。

## 没有移植的 JJDGuard 类别

| JJDGuard 类别 | 来源文件 | 原因 |
|---|---|---|
| `classified_cn`、`classified_en`（密级标识） | `data_leak.py` | 属于客户需求的第五类「保密」，本期不做 |
| `sensitive_file_*`（内部文档、客户名单、人事、财务文件名） | `data_leak.py` | 针对文件名和外发动作，不是语料里的敏感值 |
| `env_file`、`config_file` | `engine.py` | 只认格式（多行 KEY=value），里面的口令、密钥已由上面的类别覆盖 |
| `api_key_leak` | `data_leak.py` | 并入 `generic_api_key` |
| `openssh_private_key` | `engine.py` | 并入 `private_key` |
| 行业包的关键词、字段名规则（病历号字段、开户行等） | `068_industry_data_security_packs.sql` | 是按字段名或关键词告警的行业规则，用户可以在「语料规则」里自己加 |

## 与 JJDGuard 的写法差异

- JJDGuard 在归一化视图（全角转半角、去零宽字符）上匹配；这里直接在原文上匹配，全角数字写的号码不认。
- 带标签的规则允许字段名带引号（`"client_secret": "…"`），兼容 JSON 写法。
- 邮箱本地部分前面加了边界，避免长串里逐个起点回溯；本地部分本来就不超过 64 个字符。
