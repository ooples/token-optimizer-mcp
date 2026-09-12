"""Builds the tiny ONNX encoder the semantic-ranking tests run against.

WHY A GENERATED MODEL AND NOT A DOWNLOADED ONE. The adapter under test has to
be proved against real onnxruntime inference, not a stub -- otherwise the one
thing that could break in production (the tensor shapes and types actually
crossing into native code) is the one thing untested. But shipping a real
sentence encoder means ~90 MB of weights in the repository, a network fetch in
CI, and a licence to track, all to prove forty lines of glue.

So the fixture is a real ONNX graph with real weights, just a trivially small
one: a fixed embedding table, a Gather, and a mean over the sequence. It
exercises exactly the path that matters -- int64 ids in, float32 [batch, dim]
out, run through onnxruntime-node -- while weighing two kilobytes.

The weights are DETERMINISTIC, seeded here, so the same text always embeds to
the same vector and a test can assert an ordering rather than merely that
something came back.

Regenerate with:  python tests/fixtures/make-tiny-encoder.py
"""

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

VOCAB = 64
DIM = 8
OUT = 'tests/fixtures/tiny-encoder.onnx'


def main() -> None:
    rng = np.random.default_rng(20260910)
    # Unit-norm rows, so a mean-pool of ids gives a usable cosine space rather
    # than a table where magnitude swamps direction.
    table = rng.standard_normal((VOCAB, DIM)).astype(np.float32)
    table /= np.linalg.norm(table, axis=1, keepdims=True)

    graph = helper.make_graph(
        nodes=[
            helper.make_node('Gather', ['table', 'ids'], ['rows'], axis=0),
            # axis 1 is the sequence: mean-pool the tokens of each row.
            helper.make_node('ReduceMean', ['rows', 'axes'], ['embedding'], keepdims=0),
        ],
        name='tiny_encoder',
        inputs=[helper.make_tensor_value_info('ids', TensorProto.INT64, ['batch', 'seq'])],
        outputs=[helper.make_tensor_value_info('embedding', TensorProto.FLOAT, ['batch', DIM])],
        initializer=[
            numpy_helper.from_array(table, 'table'),
            numpy_helper.from_array(np.array([1], dtype=np.int64), 'axes'),
        ],
    )

    model = helper.make_model(
        graph,
        producer_name='token-optimizer-tests',
        opset_imports=[helper.make_opsetid('', 18)],
    )
    model.ir_version = 9
    onnx.checker.check_model(model)
    onnx.save(model, OUT)
    print(f'wrote {OUT}: vocab={VOCAB} dim={DIM}')


if __name__ == '__main__':
    main()
