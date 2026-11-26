# Re-run only the gemini-audio items that errored in results/<run>_p*.json, using the judge copy's own function. cwd = workspace.
import sys, json, importlib.util, glob
judge_path, run_dir, run_id = sys.argv[1:4]
spec = importlib.util.spec_from_file_location("judge", judge_path); J = importlib.util.module_from_spec(spec); spec.loader.exec_module(J)
items = {it["id"]: it for it in json.load(open("rubric.json"))["items"]}
rep = f"{run_dir}/output/repurpose.mp4"
for f in sorted(glob.glob(f"results/{run_id}_p*.json")):
    d = json.load(open(f)); changed = False
    for iid, r in d["items"].items():
        if isinstance(r, dict) and str(r.get("judge_used", "")).startswith("gemini-audio-error"):
            new = J.judge_item_gemini_audio(items[iid], rep); new["rejudged"] = "run3 thinking_budget=1024"
            d["items"][iid] = new; changed = True
            print(f, iid, new["score"], "/", new["max"], new.get("judge_used"), "|", str(new.get("why"))[:150].replace("\n", " "))
    if changed:
        d["pillar_total"] = sum(r.get("score", 0) for r in d["items"].values() if isinstance(r, dict))
        json.dump(d, open(f, "w"), indent=2)
