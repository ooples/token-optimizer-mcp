"""Run the pinned THOL runner with an explicit, validated per-repetition order.

Create the plan before a campaign and commit it with its protocol:
  python ordered_campaign.py plan order.json control,mcp,proxy 6
The wrapper changes only plan construction; THOL owns execution and resume keys.
"""
import hashlib
import json
import os
from pathlib import Path
import sys


def validate(plan, arms, reps):
    if not arms or len(set(arms)) != len(arms) or reps < 1:
        raise ValueError("Arms must be unique and repetitions positive")
    orders = plan.get("orders")
    if plan.get("arms") != arms or not isinstance(orders, list) or len(orders) != reps:
        raise ValueError("Arm order plan does not match selected arms/repetitions")
    for order in orders:
        if not isinstance(order, list) or sorted(order) != sorted(arms):
            raise ValueError("Each repetition must contain each selected arm exactly once")
    return orders


def build_plan(arms, tasks, reps):
    path = Path(os.environ["THOL_ARM_ORDER_FILE"])
    raw = path.read_bytes()
    orders = validate(json.loads(raw), arms, reps)
    print("arm-order-sha256=" + hashlib.sha256(raw).hexdigest(), flush=True)
    return [(arm, task, rep) for rep, order in enumerate(orders, 1)
            for task in tasks for arm in order]


def patched_source(source):
    original = ("plan = [(c, t, rep) for rep in range(1, args.reps + 1)\n"
                "            for t in task_names for c in comp_names]")
    if source.count(original) != 1:
        raise ValueError("Pinned THOL plan construction changed; review the adapter")
    return source.replace(original, "plan = build_ordered_plan(comp_names, task_names, args.reps)")


def main():
    if sys.argv[1:2] == ["plan"]:
        _, _, target, selected, count = sys.argv
        arms, reps = selected.split(","), int(count)
        orders = []
        for i in range(reps):
            base = arms if (i // len(arms)) % 2 == 0 else list(reversed(arms))
            shift = i % len(arms)
            orders.append(base[shift:] + base[:shift])
        plan = {"arms": arms, "orders": orders}
        validate(plan, arms, reps)
        with Path(target).open("x", encoding="utf-8") as f:
            f.write(json.dumps(plan, indent=2) + "\n")
        return
    if not os.environ.get("THOL_ARM_ORDER_FILE"):
        raise ValueError("THOL_ARM_ORDER_FILE must name the precommitted order plan")
    path = Path(sys.argv.pop(1)).resolve()
    source = patched_source(path.read_text(encoding="utf-8-sig"))
    sys.argv[0] = str(path)
    sys.path.insert(0, str(path.parent))
    exec(compile(source, str(path), "exec"), {
        "__name__": "__main__", "__file__": str(path),
        "build_ordered_plan": build_plan,
    })


if __name__ == "__main__":
    main()
