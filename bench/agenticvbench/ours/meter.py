# Run a judge.py unchanged, logging the token usage of every Anthropic / Gemini response to usage.jsonl (cwd).
import sys, json, runpy, threading, os
lock = threading.Lock()
def log(rec):
    with lock, open('usage.jsonl', 'a') as f: f.write(json.dumps(rec) + '\n')
import anthropic.resources.messages as am
_create = am.Messages.create
def create(self, *a, **k):
    r = _create(self, *a, **k)
    u = r.usage
    log({'api': 'anthropic', 'model': k.get('model'), 'in': u.input_tokens, 'out': u.output_tokens,
         'cache_read': getattr(u, 'cache_read_input_tokens', 0) or 0, 'cache_write': getattr(u, 'cache_creation_input_tokens', 0) or 0})
    return r
am.Messages.create = create
import google.genai.models as gm
_gen = gm.Models.generate_content
def gen(self, *a, **k):
    r = _gen(self, *a, **k)
    u = r.usage_metadata
    log({'api': 'gemini', 'model': k.get('model'), 'in': getattr(u, 'prompt_token_count', 0) or 0,
         'out': (getattr(u, 'candidates_token_count', 0) or 0) + (getattr(u, 'thoughts_token_count', 0) or 0)})
    return r
gm.Models.generate_content = gen
judge = sys.argv[1]
sys.path.insert(0, os.path.dirname(os.path.abspath(judge)))
sys.argv = [judge] + sys.argv[2:]
runpy.run_path(judge, run_name='__main__')
