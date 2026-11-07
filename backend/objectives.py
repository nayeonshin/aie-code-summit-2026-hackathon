import hashlib
import json
from pathlib import Path

PLAN = json.loads((Path(__file__).resolve().parents[1] / 'config/objectives.json').read_text())
OBJECTIVES = PLAN['objectives']

def allocation(count):
    total = sum(o['quota'] for o in OBJECTIVES)
    exact = [count * o['quota'] / total for o in OBJECTIVES]
    values = [int(n) for n in exact]
    for i in sorted(range(len(values)), key=lambda i: (-(exact[i] - values[i]), i))[:count - sum(values)]:
        values[i] += 1
    return {o['id']: values[i] for i, o in enumerate(OBJECTIVES)}

def schedule(count, seed):
    quotas = allocation(count)
    items = [o['id'] for o in OBJECTIVES for _ in range(quotas[o['id']])]
    # Explicit, portable Mulberry32 shuffle; matches browser schedule.ts.
    state = seed & 0xffffffff
    def random():
        nonlocal state
        state = (state + 0x6D2B79F5) & 0xffffffff
        t = ((state ^ (state >> 15)) * (state | 1)) & 0xffffffff
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & 0xffffffff)) & 0xffffffff
        return ((t ^ (t >> 14)) & 0xffffffff) / 4294967296
    for i in range(len(items) - 1, 0, -1):
        j = int(random() * (i + 1))
        items[i], items[j] = items[j], items[i]
    return items

def plan_hash(): return hashlib.sha256(json.dumps(PLAN, sort_keys=True).encode()).hexdigest()
