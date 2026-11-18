"""Export only numeric/identity result columns from a read-only historical DB."""
import json
from pathlib import Path
import sqlite3

path = Path('/results/results.sqlite')
if not path.exists():
    print('[]')
else:
    connection = sqlite3.connect('file:/results/results.sqlite?mode=ro', uri=True)
    connection.row_factory = sqlite3.Row
    available = {r['name'] for r in connection.execute('PRAGMA table_info(runs)')}
    names = ['run_id', 'competitor', 'task', 'rep', 'started_at', 'model', 'claude_version',
             'competitor_version', 'status', 'score', 'success', 'total_cost_usd',
             'input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens',
             'num_turns', 'wall_ms', 'setup_ms', 'tool_calls', 'competitor_tool_calls']
    columns = [name for name in names if name in available]
    rows = connection.execute('SELECT ' + ','.join(columns) + ' FROM runs').fetchall()
    print(json.dumps([dict(r) for r in rows]))
    connection.close()
