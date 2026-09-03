#!/usr/bin/env python3
"""Mine every Claude Code subagent transcript on this machine into one JSON file.

Reads ~/.claude/projects/*/*/subagents/agent-*.jsonl (plus the parent session's Agent
tool call, joined through the .meta.json tool-use id) and writes one row per agent:
prompt, final answer, tool counts, shell-command kinds, token usage, peak context,
wall-clock and an estimated cost. Then classifies each row by what it *did* (edits,
mutating shell, web, browser) rather than what the prompt said.

This is the extractor behind docs/subagent-census.md. It never writes anywhere but
--out. Cost uses list prices (see PRICE) with cache writes at 1.25x and reads at
0.1x input; treat dollars as relative weights, not a bill.

    python3 script/mine-subagents.py --out /tmp/census

Stdlib only. Hand-assigned kinds from the census are not reproduced here — they were a
read of 148 briefs, not a rule.
"""
import argparse, collections, glob, json, os, re, statistics as st, sys
from datetime import datetime

ROOT = os.path.expanduser('~/.claude/projects')

# $/MTok: input, output, cache write, cache read
PRICE = {
    'claude-fable-5-1': (10, 50, 12.5, 0.25), 'claude-fable-5': (10, 50, 12.5, 1.0),
    'claude-opus-5': (5, 25, 6.25, 0.5), 'claude-opus-4-8': (5, 25, 6.25, 0.5),
    'claude-opus-4-7': (5, 25, 6.25, 0.5), 'claude-opus-4-6': (5, 25, 6.25, 0.5),
    'claude-sonnet-5': (2, 10, 2.5, 0.2), 'claude-sonnet-4-6': (3, 15, 3.75, 0.3),
    'claude-haiku-4-5': (1, 5, 1.25, 0.1),
}
MUTATING_TOOLS = {'Edit', 'Write', 'NotebookEdit', 'MultiEdit'}
RO_BASH = re.compile(r'^\s*(cd\s+\S+\s*(&&|;)\s*)?(git\s+(log|diff|show|blame|status|branch|rev-parse|ls-files|grep|describe|tag|remote|stash\s+list|cat-file|shortlog)|ls|find|grep|rg|cat|head|tail|wc|sed\s+-n|awk|tree|stat|file|which|node\s+-e|python3?\s+-c|jq|sort|uniq|cut|diff|echo|pwd|du|date|env|printenv|ps|lms|curl\s+-s|nl|xargs|test\s|\[)')
IMPL = re.compile(r'^\s*(implement|fix|add|build|create|write|wire|apply|register|refactor|extend|update|make|convert|rename|migrate|port|remove|delete|replace|introduce|move|split|extract|rewrite|scaffold|set up|setup|ship|land|finish|complete|clean up|cleanup|bump|upgrade|install|generate|draft|author|prepare|record|commit|polish|tighten|harden|redesign|restructure|hook up|integrate|cut|release|publish|tag)\b', re.I)


def price(model, u):
    for k, p in PRICE.items():
        if model and model.startswith(k):
            return (u['in'] * p[0] + u['out'] * p[1] + u['cw'] * p[2] + u['cr'] * p[3]) / 1e6
    return None


def ts(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()


def bash_kind(c):
    c = c.strip()
    if re.search(r'\b(pnpm|npm|yarn|npx)\s+(test|vitest|run\s+test|tsc|typecheck|lint|check|build|-r\s+test)|\bvitest\b|\btsc\b|\bnode\s+--test|\bpytest\b|\bcargo\s+(test|check|build)|\bgo\s+(test|vet|build)', c):
        return 'build/test'
    if re.search(r'\bgit\s+(commit|push|checkout|switch|reset|rebase|merge|stash(?!\s+list)|add|rm|mv|cherry-pick|worktree\s+add|tag\s+-a)', c):
        return 'git-mutate'
    if re.search(r'(^|[;&|]\s*)(rm|mv|cp|mkdir|touch|sed\s+-i|tee|chmod|ln)\b|>\s*(?!/dev/null|&)[^&|]|cat\s*<<|\bpnpm\s+(add|install|remove|i\b)|\bnpm\s+(install|i\b|publish)|\bpip\s+install', c):
        return 'fs-mutate'
    if re.search(r'\b(pnpm|npm|npx|node|python3?|tsx|bun)\s+\S', c) and not RO_BASH.match(c):
        return 'run-script'
    if re.search(r'\bcurl\b|\bssh\b|\bdocker\b|\bgh\s', c):
        return 'external'
    return 'readonly'


def parent_calls():
    """toolUseId -> the parent's Agent tool_use input, for every main session file."""
    parent = {}
    for f in glob.glob(f'{ROOT}/*/*.jsonl'):
        proj, sid = f.split('/')[-2], os.path.basename(f)[:-6]
        for l in open(f):
            try:
                o = json.loads(l)
            except ValueError:
                continue
            m = o.get('message')
            if not isinstance(m, dict) or not isinstance(m.get('content'), list):
                continue
            for p in m['content']:
                if p.get('type') == 'tool_use' and p.get('name') in ('Agent', 'Task'):
                    i = p.get('input') or {}
                    parent[p['id']] = {'project': proj, 'session': sid, 'subagent_type': i.get('subagent_type'),
                                       'model_override': i.get('model'), 'isolation': i.get('isolation'),
                                       'description': i.get('description'), 'parent_model': m.get('model')}
    return parent


def read_agent(f, parent):
    proj, sid, aid = f.split('/')[-4], f.split('/')[-3], os.path.basename(f)[6:-6]
    meta = {}
    mf = f[:-6] + '.meta.json'
    if os.path.exists(mf):
        try:
            meta = json.load(open(mf))
        except ValueError:
            pass
    msgs, models, tools, bash_cmds, files_read = {}, collections.Counter(), collections.Counter(), [], []
    first_prompt, t0, t1, last_text, tool_bytes, cwd = None, None, None, '', 0, None
    for l in open(f):
        try:
            o = json.loads(l)
        except ValueError:
            continue
        if o.get('timestamp'):
            t = ts(o['timestamp'])
            t0 = t if t0 is None else min(t0, t)
            t1 = t if t1 is None else max(t1, t)
        cwd = cwd or o.get('cwd')
        m, typ = o.get('message'), o.get('type')
        if typ == 'user' and isinstance(m, dict):
            c = m.get('content')
            if first_prompt is None:
                first_prompt = c if isinstance(c, str) else ' '.join(p.get('text', '') for p in c if p.get('type') == 'text')
            if isinstance(c, list):
                for p in c:
                    if p.get('type') == 'tool_result':
                        cc = p.get('content')
                        tool_bytes += len(cc if isinstance(cc, str) else json.dumps(cc))
        elif typ == 'assistant' and isinstance(m, dict):
            if m.get('model'):
                models[m['model']] += 1
            if m.get('usage') and m.get('id'):
                msgs[m['id']] = m['usage']  # streamed parts share an id; keep the last usage
            for p in m.get('content', []):
                if p.get('type') == 'tool_use':
                    tools[p.get('name')] += 1
                    i = p.get('input') or {}
                    if p.get('name') == 'Bash':
                        bash_cmds.append(i.get('command', ''))
                    if p.get('name') == 'Read':
                        files_read.append(i.get('file_path', ''))
                if p.get('type') == 'text' and p.get('text'):
                    last_text = p['text']
    u, max_ctx = {'in': 0, 'out': 0, 'cw': 0, 'cr': 0}, 0
    for us in msgs.values():
        u['in'] += us.get('input_tokens', 0); u['out'] += us.get('output_tokens', 0)
        u['cw'] += us.get('cache_creation_input_tokens', 0); u['cr'] += us.get('cache_read_input_tokens', 0)
        max_ctx = max(max_ctx, us.get('input_tokens', 0) + us.get('cache_creation_input_tokens', 0) + us.get('cache_read_input_tokens', 0))
    model = models.most_common(1)[0][0] if models else None
    kinds = collections.Counter(bash_kind(c) for c in bash_cmds)
    par = parent.get(meta.get('toolUseId'), {})
    return {
        'project': proj, 'session': sid, 'agentId': aid, 'agentType': meta.get('agentType'),
        'description': meta.get('description') or par.get('description'), 'spawnDepth': meta.get('spawnDepth'),
        'subagent_type': par.get('subagent_type'), 'model_override': par.get('model_override'),
        'parent_model': par.get('parent_model'), 'cwd': cwd, 'start': t0, 'end': t1,
        'duration_s': (t1 - t0) if t0 and t1 else None, 'model': model, 'n_api_calls': len(msgs),
        'tools': dict(tools), 'n_tool_calls': sum(tools.values()), 'tool_result_bytes': tool_bytes,
        'usage': u, 'max_ctx': max_ctx, 'cost_usd': price(model, u), 'bash_kinds': dict(kinds),
        'bash_cmds': bash_cmds, 'files_read': files_read, 'prompt': first_prompt or '', 'output': last_text,
        'edits': bool(MUTATING_TOOLS & set(tools)), 'bash_mut': kinds['git-mutate'] + kinds['fs-mutate'],
        'uses_web': bool(tools.get('WebSearch') or tools.get('WebFetch')),
        'uses_browser': any(k.startswith('mcp__') and ('Browser' in k or 'chrome' in k) for k in tools),
        'delegates': bool(tools.get('Agent')), 'runs_tests': kinds['build/test'] > 0,
    }


def classify(r):
    d, p = (r['description'] or '').strip(), r['prompt'].strip()
    intent = 'implement' if IMPL.match(d) or re.match(r'^\s*(you are (implementing|building|applying|the implementer)|implement|fix|add|build|create|write)\b', p, re.I) else 'other'
    if re.search(r"session limit|usage limit", r['output'][:200], re.I) and not r['output'].strip():
        return 'aborted'
    if r['uses_browser']:
        return 'browser'
    if r['edits'] or r['bash_mut']:
        return 'implement'
    if intent == 'implement':
        return 'delegating-implementer' if r['delegates'] else 'implement-no-edit'
    if r['uses_web']:
        return 'web-research' if r['tools'].get('Read', 0) + r['tools'].get('Bash', 0) < 3 else 'web+code-research'
    if r['runs_tests'] and not re.search(r'\b(find|trace|where|how|why|report|audit|survey|map|investigate|explain|list)\b', p[:600], re.I):
        return 'run/verify'
    return 'investigate'


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--out', required=True, help='directory for rows.json and summary.txt')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    parent = parent_calls()
    rows = [read_agent(f, parent) for f in glob.glob(f'{ROOT}/*/*/subagents/*.jsonl')]
    n_files = len(rows)
    best = {}
    for r in rows:  # the same agent can be copied into two session dirs; keep the one with meta
        if r['agentId'] not in best or (not best[r['agentId']]['agentType'] and r['agentType']):
            best[r['agentId']] = r
    rows = list(best.values())
    for r in rows:
        r['cat'] = classify(r)
    json.dump(rows, open(os.path.join(a.out, 'rows.json'), 'w'))
    med = lambda xs: round(st.median([x for x in xs if x is not None]), 1) if any(x is not None for x in xs) else None
    lines = [f'{len(rows)} distinct subagents from {n_files} transcript files ({n_files - len(rows)} duplicates dropped)', '']
    lines.append(f"{'category':24s} {'n':>5} {'est $':>8} {'med dur s':>10} {'med api':>8} {'med ctx':>9}")
    for k, n in collections.Counter(r['cat'] for r in rows).most_common():
        rs = [r for r in rows if r['cat'] == k]
        lines.append(f"{k:24s} {n:5d} {sum(r['cost_usd'] or 0 for r in rs):8.0f} {med([r['duration_s'] for r in rs])!s:>10} {med([r['n_api_calls'] for r in rs])!s:>8} {med([r['max_ctx'] for r in rs])!s:>9}")
    lines.append(''); lines.append('models: ' + str(collections.Counter(r['model'] for r in rows).most_common()))
    lines.append('projects: ' + str(collections.Counter(r['project'] for r in rows).most_common()))
    open(os.path.join(a.out, 'summary.txt'), 'w').write('\n'.join(lines) + '\n')
    print('\n'.join(lines))


if __name__ == '__main__':
    main()
