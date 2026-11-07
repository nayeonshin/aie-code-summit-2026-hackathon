"""Configure local/remote secrets without printing or embedding them in assets."""
import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[1]

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--publish', action='store_true', help='Upload secrets to the already deployed Worker with Wrangler')
    args = parser.parse_args()
    token_file = ROOT / '.deploy.env'
    if not token_file.exists():
        fd = os.open(token_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w') as file: file.write('ADMIN_TOKEN=' + secrets.token_urlsafe(36) + '\n')
    token = dotenv_values(token_file).get('ADMIN_TOKEN')
    if not token: raise RuntimeError('ADMIN_TOKEN missing from .deploy.env')
    local = dotenv_values(ROOT / '.env')
    values = {'ADMIN_TOKEN': token}
    for name in ('SUBQ_API_KEY', 'MODEL_API_KEY'):
        value = os.getenv(name) or local.get(name)
        if value: values[name] = value
    dev = ROOT / '.dev.vars'
    fd = os.open(dev, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w') as file:
        for name, value in values.items(): file.write(name + '=' + json.dumps(value) + '\n')
    print('Local secrets configured. Admin token is in gitignored .deploy.env (not printed).')
    print('Meta enabled.' if 'MODEL_API_KEY' in values else 'Meta remains disabled: add MODEL_API_KEY to .env when billing is ready.')
    if args.publish:
        subprocess.run(['npx', 'wrangler', 'secret', 'bulk'], cwd=ROOT, input=json.dumps(values), text=True, check=True)

if __name__ == '__main__': main()
