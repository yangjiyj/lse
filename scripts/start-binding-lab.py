#!/usr/bin/env python3
"""Start only the isolated 18092 binding lab using owner-only configuration."""
import json
import os
from pathlib import Path
import stat
from urllib.parse import urlsplit

def private_file(path):
    info=path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode & 0o077:
        raise SystemExit("configuration must be an owner-only regular file")
    return path
root=Path(__file__).resolve().parents[1]
values=json.loads(private_file(root/'work/private/runtime.json').read_text())
allowed={'DATABASE_URL','JWT_SECRET','LICENSE_ENFORCE','LSE_PLATFORM_TENANT_BINDINGS_FILE','LSE_TEST','NODE_ENV','REDIS_URL'}
if set(values)!=allowed or not all(isinstance(v,str) for v in values.values()):
    raise SystemExit('unexpected configuration schema')
db=urlsplit(values['DATABASE_URL'])
if db.hostname not in ('127.0.0.1','localhost') or db.port!=55573 or db.path!='/cap_lse_test':
    raise SystemExit('only the dedicated lab database is permitted')
if values['NODE_ENV']!='test' or values['LSE_TEST']!='1':
    raise SystemExit('this launcher supports the isolated test instance only')
binding=Path(values['LSE_PLATFORM_TENANT_BINDINGS_FILE'])
if binding!=root/'work/private/bindings.json':
    raise SystemExit('unexpected binding file')
private_file(binding)
env={key:value for key,value in os.environ.items() if key in {'HOME','USER','LOGNAME','PATH','LANG','LC_ALL','TZ'}}
env.update(values)
env['API_PORT']='18092'
os.chdir(root/'apps/api')
os.execve('/usr/bin/node',['node','--import','tsx','scripts/binding-lab-server.ts'],env)
