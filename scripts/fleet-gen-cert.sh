#!/usr/bin/env bash
# 鉴盾自管终端接入：生成自签叶子证书（EC P-256）与 tls-deployment.json。
# 规格依据：docs/endpoint-fleet/protocol-subset.md §0、§0.2。
#   - 采集器只信任钉扎的"自签叶子证书"，CA 签发的叶子证书会握手失败；
#   - tls-deployment.json 的键恰好为 server / tls_server_cert_pem / tls_server_cert_sha256；
#   - PEM <= 4096 字节且只含 1 张证书；sha256 为证书 DER 的小写 hex。
set -euo pipefail

usage() {
  cat <<'EOF'
用法：
  fleet-gen-cert.sh --server https://主机[:端口] (--ip IP | --dns 域名)... [选项]

必填：
  --server URL    终端访问鉴盾所用的地址，只能是 https://主机[:端口]
                  （不能带路径、查询串、用户信息）。须与 FLEET_PUBLIC_BASE_URL
                  以及终端 enroll 的 --server 完全一致。
  --ip IP         证书 SAN 的 IP，可重复
  --dns 域名      证书 SAN 的 DNS 名，可重复
                  （--ip / --dns 至少一个，且必须覆盖 --server 中的主机）

选项：
  --days N        有效期天数，默认 825
  --out DIR       输出目录，默认当前目录
  --cn NAME       证书主题 CN，默认 lse-fleet
  --force         允许覆盖已存在的输出文件
  -h, --help      显示本帮助

输出（在 --out 目录）：
  fleet-server.key       私钥（权限 0600，只放在鉴盾 TLS 终止处，绝不分发）
  fleet-server.crt       证书 PEM（可挂载给 FLEET_TLS_CERT_PEM_PATH，不含私钥）
  tls-deployment.json    下发给终端的部署文件（键恰好 3 个）
EOF
}

die() { echo "错误：$*" >&2; exit 2; }

server=""
days=825
out="."
cn="lse-fleet"
force=0
ips=()
dnss=()

while (($#)); do
  case "$1" in
    --server) [[ $# -ge 2 ]] || die "--server 缺少参数"; server="$2"; shift 2 ;;
    --ip)     [[ $# -ge 2 ]] || die "--ip 缺少参数"; ips+=("$2"); shift 2 ;;
    --dns)    [[ $# -ge 2 ]] || die "--dns 缺少参数"; dnss+=("$2"); shift 2 ;;
    --days)   [[ $# -ge 2 ]] || die "--days 缺少参数"; days="$2"; shift 2 ;;
    --out)    [[ $# -ge 2 ]] || die "--out 缺少参数"; out="$2"; shift 2 ;;
    --cn)     [[ $# -ge 2 ]] || die "--cn 缺少参数"; cn="$2"; shift 2 ;;
    --force)  force=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "未知参数：$1" ;;
  esac
done

command -v openssl >/dev/null 2>&1 || die "未找到 openssl"

[[ -n "$server" ]] || { usage >&2; die "必须提供 --server"; }
[[ "$days" =~ ^[0-9]+$ ]] && ((days >= 1 && days <= 3650)) || die "--days 须为 1–3650 的整数"
[[ "$cn" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "--cn 只允许字母、数字、点、下划线、连字符（最长 64）"

# --server：仅 https://host[:port]；host 为域名、IPv4 或 [IPv6]
server_re='^https://(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?)(:([0-9]{1,5}))?$'
[[ "$server" =~ $server_re ]] || die "--server 格式不合法：只能是 https://主机[:端口]，不能带路径、查询串或用户信息（收到：$server）"
server_host="${BASH_REMATCH[1]}"
server_port="${BASH_REMATCH[4]:-}"
if [[ -n "$server_port" ]]; then
  ((10#$server_port >= 1 && 10#$server_port <= 65535)) || die "--server 端口超出 1–65535"
fi
server_host_bare="${server_host#[}"; server_host_bare="${server_host_bare%]}"

# SAN 校验
ipv4_re='^([0-9]{1,3}\.){3}[0-9]{1,3}$'
dns_re='^[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$'
san=()
covered=0
for ip in ${ips[@]+"${ips[@]}"}; do
  if [[ "$ip" =~ $ipv4_re ]]; then
    IFS=. read -r a b c d <<<"$ip"
    for o in "$a" "$b" "$c" "$d"; do ((10#$o <= 255)) || die "--ip 不是合法 IPv4：$ip"; done
  elif [[ "$ip" == *:* && "$ip" =~ ^[0-9A-Fa-f:.]+$ ]]; then
    :
  else
    die "--ip 不合法：$ip"
  fi
  san+=("IP:$ip")
  [[ "$(tr 'A-F' 'a-f' <<<"$ip")" == "$(tr 'A-F' 'a-f' <<<"$server_host_bare")" ]] && covered=1
done
for d in ${dnss[@]+"${dnss[@]}"}; do
  [[ "$d" =~ $dns_re && ${#d} -le 253 ]] || die "--dns 不合法：$d"
  san+=("DNS:$d")
  [[ "$(tr 'A-Z' 'a-z' <<<"$d")" == "$(tr 'A-Z' 'a-z' <<<"$server_host_bare")" ]] && covered=1
done
((${#san[@]} > 0)) || die "至少需要一个 --ip 或 --dns"
((covered == 1)) || die "SAN 未覆盖 --server 中的主机 ${server_host_bare}：请用 --ip/--dns 加入它（终端校验 SAN，不匹配会握手失败）"
san_csv=$(IFS=,; echo "${san[*]}")

# 输出文件
mkdir -p "$out"
out=$(cd "$out" && pwd -P)
key="$out/fleet-server.key"
crt="$out/fleet-server.crt"
dep="$out/tls-deployment.json"
if ((force == 0)); then
  for f in "$key" "$crt" "$dep"; do
    [[ ! -e "$f" ]] || die "文件已存在：$f（确认要覆盖请加 --force；覆盖证书意味着所有终端需执行 set-https 轮换）"
  done
fi

# 在输出目录内建私有临时目录，成功后再原子改名，失败则清理
tmp=$(umask 077 && mktemp -d "$out/.fleet-gen-cert.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

(
  umask 077
  openssl ecparam -name prime256v1 -genkey -noout -out "$tmp/key.pem" 2>/dev/null
  openssl req -x509 -new -key "$tmp/key.pem" -sha256 -days "$days" \
    -subj "/CN=$cn" \
    -addext "subjectAltName=$san_csv" \
    -addext "basicConstraints=critical,CA:FALSE" \
    -addext "keyUsage=critical,digitalSignature" \
    -addext "extendedKeyUsage=serverAuth" \
    -out "$tmp/crt.pem" 2>/dev/null
)

# 指纹：证书 DER 的 sha256（小写 hex）
sha=$(openssl x509 -in "$tmp/crt.pem" -outform DER | openssl dgst -sha256 | awk '{print $NF}' | tr 'A-F' 'a-f')
[[ "$sha" =~ ^[0-9a-f]{64}$ ]] || die "计算指纹失败"

# 规格检查：PEM <= 4096 字节、仅 1 张证书
pem_bytes=$(wc -c <"$tmp/crt.pem" | tr -d ' ')
((pem_bytes <= 4096)) || die "证书 PEM 超过 4096 字节（$pem_bytes），采集器不接受"
[[ "$(grep -c 'BEGIN CERTIFICATE' "$tmp/crt.pem")" == "1" ]] || die "证书文件不是恰好 1 张证书"

# tls-deployment.json：键恰好 server / tls_server_cert_pem / tls_server_cert_sha256
# PEM 只含 base64、'-' 和换行，无需额外转义；换行转成 \n
pem_escaped=$(awk 'BEGIN{ORS="\\n"} {print}' "$tmp/crt.pem")
printf '{"server":"%s","tls_server_cert_pem":"%s","tls_server_cert_sha256":"%s"}\n' \
  "$server" "$pem_escaped" "$sha" >"$tmp/dep.json"

chmod 0600 "$tmp/key.pem"
chmod 0644 "$tmp/crt.pem" "$tmp/dep.json"
mv -f "$tmp/key.pem" "$key"
mv -f "$tmp/crt.pem" "$crt"
mv -f "$tmp/dep.json" "$dep"

not_after=$(openssl x509 -in "$crt" -noout -enddate | cut -d= -f2)
cat <<EOF
已生成自签叶子证书（EC P-256，CA:FALSE）：
  私钥  : $key   （0600，仅放鉴盾 TLS 终止处，不要分发、不要入库）
  证书  : $crt
  部署  : $dep   （发给终端，enroll/set-https 的 --tls-config）
  SAN   : $san_csv
  到期  : $not_after
  server: $server
  SHA-256 指纹（DER）: $sha

使用提示：
  1. 把证书挂载给鉴盾 API 容器，设置 FLEET_TLS_CERT_PEM_PATH 指向它（只放证书，不放私钥）；
     FLEET_PUBLIC_BASE_URL 必须等于上面的 server。
  2. TLS 终止处（独立端口）使用 fleet-server.crt + fleet-server.key。
  3. 把 tls-deployment.json 分发给终端；也可在鉴盾界面/接口 GET /api/fleet/deployment-info/tls-deployment.json 下载，
     两者的指纹应一致。
  4. 到期前必须在同主机、同端口下生成新证书并让每台终端执行 set-https；换主机或端口需重新接入。
EOF
