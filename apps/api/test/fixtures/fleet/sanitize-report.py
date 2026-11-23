import json,re,pathlib,hashlib
src='/fast/home-yj/jd-20261024/fixtures/demo-host-probe-report.raw.json'
p=json.load(open(src))
# 白名单重建：不拷贝任何原始正文、账户、进程、网络地址或安装位置。
def checks(o):
 return {'checks':[{'rule_id':c.get('rule_id',''),'status':c.get('status','unknown'),'severity':c.get('severity','info'),'evidence_code':(c.get('evidence_code','') if re.fullmatch(r'[a-z0-9_.-]{1,100}',str(c.get('evidence_code',''))) else ''),'reason_zh':('终端未提供完成此项检查所需的信息。' if c.get('status')=='unknown' else '终端已完成此项静态检查。')} for c in o.get('static_assessment',{}).get('checks',[])]}
def tool(m):
 return {k:m[k] for k in ['name','scope','transport'] if k in m}|{'static_assessment':checks(m)}
def config(c):
 return {k:c[k] for k in ['permission_mode','auto_approval','sandbox_mode','hooks_present'] if k in c}
assets=[]
for i,a in enumerate(p['assets']):
 e=a.get('evidence',{}); kind=a.get('kind','')
 name=a.get('name','') if kind=='cli_agent' else e.get('server_name','ppt') if kind=='mcp_server' else ('技能-%03d'%i if kind=='skill' else '测试对象-%03d'%i)
 assets.append({'kind':kind,'name':name,'version':(a.get('version') if re.fullmatch(r'(?:[0-9]+(?:\.[0-9]+)*(?:[-+][a-zA-Z0-9.-]+)?|version_unknown)',str(a.get('version',''))) else ''),'source_id':'test-asset-%03d'%i,'evidence':{'config':config(e.get('config',{})),'static_assessment':checks(e),**{k:e[k] for k in ['scope','transport','server_name'] if k in e},'mcp_servers':[tool(m) for m in e.get('mcp_servers',[])],'skills':[],**({'install_path_hash':e['install_path_hash']} if 'install_path_hash' in e else {})}})
out={'schema_version':p.get('schema_version'),'report_id':'test-report','endpoint_id':'test-endpoint','host':{'hostname':'test-host','username':'test-user','ip':'192.0.2.10','mac':'02:00:00:00:00:01','serial':'test-serial'},'status':p.get('status'),'scanned_at':'2026-10-23T14:08:00Z','collectors':[{'name':c.get('name'),'status':c.get('status'),**({'error_code':c['error_code']} if re.fullmatch(r'[a-z0-9_.-]{1,100}',str(c.get('error_code',''))) else {})} for c in p.get('collectors',[])],'assets':assets}
target=pathlib.Path('apps/api/test/fixtures/fleet/demo-host-probe-report.json');target.parent.mkdir(parents=True,exist_ok=True);target.write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
print('已生成白名单脱敏夹具，资产数',len(assets))
