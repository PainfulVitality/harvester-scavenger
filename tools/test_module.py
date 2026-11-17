"""Run each test file directly and verify runtime syntax: python tools/test_module.py."""
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]

def run():
    total = 0
    for path in sorted((ROOT / 'tests').glob('*.test.mjs')):
        result = subprocess.run(['node', str(path)], cwd=ROOT, capture_output=True, text=True)
        if result.returncode:
            print(result.stdout + result.stderr)
            return result.returncode
        counts = re.findall(r'^# tests (\d+)$', result.stdout, re.MULTILINE)
        assert counts, f'No tests executed in {path.name}'
        count = int(counts[-1])
        total += count
        print(f'PASS {path.name}: {count} tests')
    for path in sorted((ROOT / 'scripts').glob('*.mjs')):
        subprocess.run(['node', '--check', str(path)], cwd=ROOT, check=True, capture_output=True)
    print(f'PASS {total} tests; all runtime scripts parse successfully')
    return 0

if __name__ == '__main__':
    sys.exit(run())
