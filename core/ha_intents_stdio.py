#!/usr/bin/env python3
"""Canvas adapter for the pinned OHF-Voice English intent subset.

Adapted grammar data is CC-BY-4.0; see vendor/ohf-intents/NOTICE.
"""
import json
import sys
from pathlib import Path

from hassil import Intents, recognize

ROOT = Path(__file__).parent / "vendor" / "ohf-intents" / "en"


def load_intents():
    merged = {
        "language": "en", "intents": {},
        "lists": {"name": {"wildcard": True}, "area": {"wildcard": True}, "floor": {"wildcard": True}},
        "expansion_rules": {},
    }
    import yaml
    common = yaml.safe_load((ROOT / "_common.yaml").read_text()) or {}
    for key in ("lists", "expansion_rules", "skip_words", "settings"):
        if key in common:
            if key in ("lists", "expansion_rules"):
                merged[key].update(common[key])
            else:
                merged[key] = common[key]
    vendor_root = ROOT.parent
    for directory, key in (
        (vendor_root / "lists", "lists"),
        (vendor_root / "lists" / "en", "lists"),
        (vendor_root / "rules", "expansion_rules"),
        (vendor_root / "rules" / "en", "expansion_rules"),
    ):
        for path in directory.glob("*.yaml"):
            fragment = yaml.safe_load(path.read_text()) or {}
            merged[key].update(fragment.get(key, {}))
    for path in ROOT.rglob("*.yaml"):
        if path.name == "_common.yaml":
            continue
        data = yaml.safe_load(path.read_text()) or {}
        intent_name = path.parent.name
        merged["intents"].setdefault(intent_name, {"data": []})["data"].extend(data.get("data", []))
    return merged


BASE_SCHEMA = load_intents()


def parse(text, names, areas):
    schema = json.loads(json.dumps(BASE_SCHEMA))
    schema["lists"]["name"] = {"values": sorted(set(names))}
    schema["lists"]["area"] = {"values": sorted(set(areas))}
    intents = Intents.from_dict(schema)
    result = recognize(text, intents)
    if result is None:
        return {"matched": False}
    slots = {}
    for entity in getattr(result, "entities_list", []):
        slots[entity.name] = entity.value
    return {"matched": True, "intent": result.intent.name, "slots": slots}


if len(sys.argv) == 4:
    print(json.dumps(parse(sys.argv[1], json.loads(sys.argv[2]), json.loads(sys.argv[3]))))
    raise SystemExit(0)

for line in sys.stdin:
    try:
        request = json.loads(line)
        print(json.dumps(parse(str(request.get("text", "")), request.get("names", []), request.get("areas", []))), flush=True)
    except Exception as error:
        print(json.dumps({"matched": False, "error": str(error)}), flush=True)