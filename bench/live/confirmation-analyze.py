"""Paired, family-stratified BCa bootstrap and preregistered decision gates."""
import json
import math
import sys
from pathlib import Path
import numpy as np
from scipy.stats import norm


def estimate(groups):
    geo = math.exp(np.mean([np.log(g[:, 0] / g[:, 1]).mean() for g in groups]))
    dollar = sum(g[:, 0].mean() for g in groups) / sum(g[:, 1].mean() for g in groups)
    return np.array([geo, dollar])


def intervals(groups, resamples=20000, seed=9152026):
    rng = np.random.default_rng(seed)
    observed = estimate(groups)
    geo, ours, theirs = np.zeros(resamples), np.zeros(resamples), np.zeros(resamples)
    for g in groups:
        indices = rng.integers(0, len(g), size=(resamples, len(g)))
        paired = g[indices]
        geo += np.log(paired[:, :, 0] / paired[:, :, 1]).mean(axis=1) / len(groups)
        ours += paired[:, :, 0].mean(axis=1)
        theirs += paired[:, :, 1].mean(axis=1)
    samples = np.column_stack((np.exp(geo), ours / theirs))
    jackknife = []
    for k, g in enumerate(groups):
        for i in range(len(g)):
            subset = list(groups)
            subset[k] = np.delete(g, i, axis=0)
            jackknife.append(estimate(subset))
    jackknife = np.array(jackknife)
    answer = []
    for j, value in enumerate(observed):
        dist = samples[:, j]
        rank = ((dist < value).sum() + 0.5 * (dist == value).sum()) / len(dist)
        z0 = norm.ppf(np.clip(rank, 0.5 / len(dist), 1 - 0.5 / len(dist)))
        delta = jackknife[:, j].mean() - jackknife[:, j]
        denominator = 6 * (np.sum(delta**2) ** 1.5)
        acceleration = float(np.sum(delta**3) / denominator) if denominator else 0
        zs = norm.ppf([0.025, 0.975])
        adjusted = norm.cdf(z0 + (z0 + zs) / (1 - acceleration * (z0 + zs)))
        bounds = np.quantile(dist, adjusted)
        answer.append({"ratio": float(value), "reductionPercent": float(100*(1-value)), "ci95Ratio": bounds.tolist(), "method": "paired family-stratified BCa", "degenerate": bool(np.ptp(dist) == 0)})
    return dict(zip(["geometricPairedCost", "equalFamilyDollarCost"], answer))


def attempt_accounting(case, row, audit, rates):
    """Preserve each arm independently; unknown usage is never zero cost."""
    known = dict(input=0, cached=0, output=0)
    unknown = []
    ledger = row.get("ledgerUsage") or []
    for index, entry in enumerate(ledger):
        usage = entry.get("usage") or {}
        fields = ["input_tokens", "cached_input_tokens", "output_tokens"]
        valid = all(type(usage.get(k)) is int and usage[k] >= 0 for k in fields)
        valid = valid and usage["cached_input_tokens"] <= usage["input_tokens"]
        if not valid:
            unknown.append({"request": index + 1, "status": entry.get("status")})
            continue
        for target, source in zip(known, fields):
            known[target] += usage[source]
    cost = ((known["input"]-known["cached"])*rates["uncached"]+known["cached"]*rates["cached"]+known["output"]*rates["output"])/1e6
    errors = audit.get("clientErrors", row.get("clientErrors", []))
    return {"case": case["id"], "family": case["family"], "arm": row["arm"],
            "verdict": audit["verdict"], "infrastructureFailure": bool(errors or any(e.get("status") != 200 for e in ledger)),
            "clientErrors": errors, "knownUsage": known, "knownEstimatedUsd": cost,
            "unknownUsageRequests": unknown, "ledgerPresent": bool(ledger),
            "costComplete": bool(ledger) and not unknown,
            "totalEstimatedUsd": cost if ledger and not unknown else None}


def analyze(study):
    plan = json.loads((study / "plan.json").read_text())
    execution = json.loads((study / "execution.json").read_text())
    issues, pairs, attempts = [], [], []
    if execution["status"] != "complete":
        issues.append("Execution is incomplete")
    if len(execution["pairs"]) != plan["pairs"]:
        issues.append("Unexpected execution count")
    rates = plan["scenario"]["usdPerMillion"]
    for case in plan["schedule"]:
        path = study / "cases" / case["id"]
        try:
            rows = json.loads((path / "results.json").read_text())
            audit = json.loads((path / "validation.json").read_text())
            manifest = json.loads((path / "manifest.json").read_text())
            if len(rows) != 2 or {r["arm"] for r in rows} != {"proxy", "headroom"}:
                raise ValueError("Missing/duplicate arms")
            if len(audit) != 2 or {r["arm"] for r in audit} != {"proxy", "headroom"}:
                raise ValueError("Missing/duplicate audit arms")
            if (manifest["model"] != plan["model"] or manifest["caseSuite"] != plan["caseSuite"] or manifest["readMode"] != case["readMode"] or manifest["arms"] != case["arms"] or manifest["seedOffset"] != case["seed"]-1 or manifest["tasks"] != [case["task"]] or manifest["reps"] != 1):
                raise ValueError("Protocol mismatch")
            record = {"id": case["id"], "family": case["family"], "arms": {}}
            # Validate identities and account for BOTH arms before attempting
            # paired cost inference. One missing ledger cannot erase its peer.
            for r in rows:
                if r["seed"] != case["seed"] or r["task"] != case["task"] or r["rep"] != 1:
                    raise ValueError("Case mismatch")
            attempts.extend(attempt_accounting(case, r, next(a for a in audit if a["arm"] == r["arm"]), rates) for r in rows)
            for r in rows:
                verdict = next(a["verdict"] for a in audit if a["arm"] == r["arm"])
                if r["seed"] != case["seed"] or r["task"] != case["task"] or r["rep"] != 1:
                    raise ValueError("Case mismatch")
                if verdict not in ["PASS", "FAIL"]:
                    issues.append(f'{case["id"]}/{r["arm"]}: {verdict}')
                u, ledger = r["usage"], r["ledgerUsage"]
                if not ledger or any(e["status"] != 200 for e in ledger):
                    raise ValueError("Provider error or missing ledger")
                for key, field in [("input", "input_tokens"), ("cached", "cached_input_tokens"), ("output", "output_tokens")]:
                    if not isinstance(u[key], int) or u[key] < 0 or any(not isinstance(e["usage"][field], int) or e["usage"][field] < 0 for e in ledger) or sum(e["usage"][field] for e in ledger) != u[key]:
                        raise ValueError("Invalid/unreconciled usage")
                if u["cached"] > u["input"] or any(e["usage"]["cached_input_tokens"] > e["usage"]["input_tokens"] for e in ledger):
                    raise ValueError("Invalid cached subset")
                cost = ((u["input"]-u["cached"])*rates["uncached"]+u["cached"]*rates["cached"]+u["output"]*rates["output"])/1e6
                if cost <= 0:
                    raise ValueError("Nonpositive cost")
                first = ledger[0]["usage"]
                record["arms"][r["arm"]] = {"verdict": verdict, "estimatedUsd": cost, "firstRequestColdSensitivityUsd": cost+first["cached_input_tokens"]*(rates["uncached"]-rates["cached"])/1e6, "input": u["input"], "cached": u["cached"], "output": u["output"], "firstInput": first["input_tokens"], "firstCached": first["cached_input_tokens"], "continuationInput": u["input"]-first["input_tokens"], "continuationCached": u["cached"]-first["cached_input_tokens"], "requests": r["requests"], "agentSeconds": r["agentSeconds"], "seconds": r["seconds"]}
            pairs.append(record)
        except (OSError, KeyError, ValueError, TypeError, StopIteration) as error:
            issues.append(f'{case["id"]}: {error}')
    groups = [np.array([[p["arms"]["proxy"]["estimatedUsd"], p["arms"]["headroom"]["estimatedUsd"]] for p in pairs if p["family"] == family]) for family in plan["families"]]
    complete = len(pairs) == plan["pairs"] and all(len(g) == plan["pairsPerFamily"] for g in groups)
    passed = sum(a["arm"] == "proxy" and a["verdict"] == "PASS" for a in attempts)
    quality_lower = 0.05**(1/plan["pairs"]) if passed == plan["pairs"] else None
    result = {"complete": complete and not issues, "issues": issues, "pairsMeasured": len(pairs), "pairsPlanned": plan["pairs"], "proxyPasses": passed, "headroomPasses": sum(p["arms"]["headroom"]["verdict"] == "PASS" for p in pairs), "zeroFailureOneSided95SuccessLowerBound": quality_lower, "pairs": pairs, "limitations": ["Generated synthetic cases held out from product tuning; not independent real-world repositories.", "Provider cache state is observed, not experimentally flushed. Fresh sessions may start warm.", "Intervals assume independent case pairs within the sampled workload distribution; shared provider state can introduce dependence.", "BCa intervals are approximate, and the study cannot establish superiority outside this model, rate scenario, or suite.", "First-request cold sensitivity holds model behavior and subsequent usage fixed; it is not a cold-session experiment."]}
    result.update({"attempts": attempts, "headroomPasses": sum(a["arm"] == "headroom" and a["verdict"] == "PASS" for a in attempts),
                   "attemptAccounting": {arm: {"attempts": sum(a["arm"] == arm for a in attempts),
                                               "knownEstimatedUsd": sum(a["knownEstimatedUsd"] for a in attempts if a["arm"] == arm),
                                               "unknownCostAttempts": sum(not a["costComplete"] for a in attempts if a["arm"] == arm),
                                               "infrastructureFailures": sum(a["infrastructureFailure"] for a in attempts if a["arm"] == arm)} for arm in ["proxy", "headroom"]}})
    if complete and not issues:
        result["cost"] = intervals(groups, plan["bootstrap"]["resamples"], plan["bootstrap"]["seed"])
        cold = [np.array([[p["arms"]["proxy"]["firstRequestColdSensitivityUsd"],p["arms"]["headroom"]["firstRequestColdSensitivityUsd"]] for p in pairs if p["family"] == f]) for f in plan["families"]]
        result["firstRequestColdSensitivity"] = intervals(cold,plan["bootstrap"]["resamples"],plan["bootstrap"]["seed"])
        uncached = [np.array([[(p["arms"][arm]["input"]*rates["uncached"]+p["arms"][arm]["output"]*rates["output"])/1e6 for arm in ["proxy", "headroom"]] for p in pairs if p["family"] == f]) for f in plan["families"]]
        result["allInputUncachedSensitivity"] = intervals(uncached,plan["bootstrap"]["resamples"],plan["bootstrap"]["seed"])
        result["limitations"].append("All-input-uncached sensitivity holds observed behavior fixed; it is not an observed cold-cache cohort.")
        result["familyResultsExploratory"] = {family: {"pairs":len(g),"ratios":estimate([g]).tolist(),"proxyPasses":sum(p["family"]==family and p["arms"]["proxy"]["verdict"]=="PASS" for p in pairs),"headroomPasses":sum(p["family"]==family and p["arms"]["headroom"]["verdict"]=="PASS" for p in pairs)} for family,g in zip(plan["families"],groups)}
    result["superiorityEstablished"] = bool(complete and not issues and quality_lower is not None and quality_lower >= plan["success"]["minimumOneSided95SuccessBound"] and all(not r["degenerate"] and r["ci95Ratio"][1] < plan["success"]["bothCostUpper95Below"] for r in result.get("cost",{}).values()) and "cost" in result)
    (study / "analysis.json").write_text(json.dumps(result,indent=2)+"\n")
    print(json.dumps({k:v for k,v in result.items() if k not in ["pairs","attempts","limitations"]},indent=2))
    return result


if __name__ == "__main__":
    analyze(Path(sys.argv[1]).resolve())
