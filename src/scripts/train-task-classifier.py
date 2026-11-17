"""Train a private, data-only task model. Python is needed here, never in hooks."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unicodedata

CATEGORIES = {'fix', 'build', 'rewrite', 'survey', 'locate', 'explain', 'unknown'}
FORMAT = 'token-optimizer-task-classifier/1'
MAX_BYTES = 5 * 1024 * 1024


def clip(text, tail=False):
    # Hooks bound JavaScript strings in UTF-16 code units, including emoji.
    raw = text.encode('utf-16-le', errors='surrogatepass')
    return (raw[-8000:] if tail else raw[:8000]).decode('utf-16-le', errors='surrogatepass')


def records(path):
    if path.stat().st_size > MAX_BYTES:
        raise ValueError('Training input exceeds 5 MiB')
    rows = []
    for number, line in enumerate(path.read_text(encoding='utf-8-sig').splitlines(), 1):
        if not line.strip():
            continue
        row = json.loads(line)
        if not isinstance(row, dict) or not isinstance(row.get('label'), str) or row['label'] not in CATEGORIES or not isinstance(row.get('prompt'), str):
            raise ValueError(f'Invalid training record at line {number}')
        before = row.get('before', '')
        if not isinstance(before, str):
            raise ValueError(f'Invalid context at line {number}')
        weight = row.get('weight', 1.0)
        if not isinstance(weight, (int, float)) or not .1 <= weight <= 10:
            raise ValueError(f'Invalid example weight at line {number}')
        rows.append(dict(prompt=clip(row['prompt']), before=clip(before, tail=True), label=row['label'], weight=float(weight)))
        if len(rows) > 5000:
            raise ValueError('Training input exceeds 5,000 records')
    return rows


def normalize(text):
    return unicodedata.normalize('NFC', text).lower()


def train(private_path=None):
    try:
        from scipy.sparse import hstack
        from sklearn.feature_extraction.text import TfidfVectorizer
        from sklearn.linear_model import LogisticRegression
    except ImportError as error:
        raise RuntimeError('Training requires scikit-learn: install it in your chosen Python environment with python -m pip install scikit-learn') from error
    public = records(Path(__file__).with_name('task-classifier-examples.jsonl'))
    rows = list(public)
    rows += [dict(prompt='yes, do that', before='My proposed next action is: ' + r['prompt'], label=r['label'], weight=.5)
             for r in public if r['label'] != 'unknown']
    for text in ['thanks', 'thank you', 'that was intentional', 'correct', 'that is the right workspace', 'good to know', 'nothing else', 'never mind', 'stop']:
        rows.append(dict(prompt=text, before='The bug is repaired and all tests pass.', label='unknown', weight=1.0))
    private = records(private_path) if private_path else []
    rows += private
    vectorizer = TfidfVectorizer(ngram_range=(1, 2), min_df=2, max_features=15000, sublinear_tf=True,
                                 token_pattern=r'(?u)\b\w{2,96}\b', preprocessor=normalize)
    prompt = vectorizer.fit_transform([r['prompt'] for r in rows])
    context = vectorizer.transform([r['before'] for r in rows])
    context_weight = .2
    classifier = LogisticRegression(C=10, max_iter=1500, random_state=20261117)
    classifier.fit(hstack([prompt, context_weight * context]).tocsr(), [r['label'] for r in rows],
                   sample_weight=[r['weight'] for r in rows])
    model = dict(format=FORMAT, labels=classifier.classes_.tolist(), terms=vectorizer.get_feature_names_out().tolist(),
                 idf=vectorizer.idf_.round(8).tolist(), bias=classifier.intercept_.round(8).tolist(),
                 weights=classifier.coef_.round(8).tolist(), contextWeight=context_weight, minimumScore=.25, switchThreshold=.85,
                 training=dict(public_records=len(public), private_records=len(private),
                               method='word/bigram TF-IDF, L2 normalization, multinomial logistic regression'))
    return model


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    model = train(args.input)
    raw = json.dumps(model, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n'
    args.output.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.task-classifier-', suffix='.json', dir=args.output.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as stream:
            stream.write(raw)
        os.replace(temporary, args.output)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print(json.dumps(dict(model=str(args.output.resolve()), id=hashlib.sha256(raw.encode()).hexdigest()[:12],
                          features=len(model['terms']), public_records=model['training']['public_records'],
                          private_records=model['training']['private_records'])))


if __name__ == '__main__':
    main()
