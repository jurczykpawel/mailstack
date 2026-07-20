#!/usr/bin/env python3
"""Standalone copy of vault products/_catalog/catalog.py's check_layout() + word-count
checks from n8n-template-publishing-guidelines.md, so these files can be verified
without wiring them into the Sellf catalog machinery."""
import json, glob, os, re

HERE = os.path.dirname(os.path.abspath(__file__))


def check_layout(path, nw=100, nh=100):
    wf = json.load(open(path))
    nodes = wf["nodes"]

    def boxes(cs):
        return [
            (n["name"], n["position"][0], n["position"][1], n["parameters"].get("width", 0), n["parameters"].get("height", 0))
            for n in nodes if "stickyNote" in n["type"] and n["parameters"].get("color") in cs
        ]

    sect = boxes({7})
    over = boxes({1, None})
    reals = [(n["name"], n["position"][0], n["position"][1]) for n in nodes if "stickyNote" not in n["type"]]
    ins = lambda nx, ny, bx, by, bw, bh: bx <= nx and nx + nw <= bx + bw and by <= ny and ny + nh <= by + bh
    ovl = lambda a, b: a[1] < b[1] + b[3] and b[1] < a[1] + a[3] and a[2] < b[2] + b[4] and b[2] < a[2] + a[4]
    iss = []
    for nm, x, y in reals:
        if sect and not any(ins(x, y, *s[1:]) for s in sect):
            iss.append(f"node '{nm}' not fully inside any section sticky")
    for o in over:
        for nm, x, y in reals:
            if o[1] <= x + nw and x <= o[1] + o[3] and o[2] <= y + nh and y <= o[2] + o[4]:
                iss.append(f"overview overlaps node '{nm}'")
        for s in sect:
            if ovl(o, s):
                iss.append(f"overview overlaps section '{s[0]}'")
    for i in range(len(sect)):
        for j in range(i + 1, len(sect)):
            if ovl(sect[i], sect[j]):
                iss.append(f"sections overlap: '{sect[i][0]}' / '{sect[j][0]}'")
    return iss


def check_overview_words(path):
    wf = json.load(open(path))
    for n in wf["nodes"]:
        if "stickyNote" in n["type"] and n["parameters"].get("color") in (1, None):
            words = len(re.findall(r"\S+", n["parameters"]["content"]))
            has_how = "How it works" in n["parameters"]["content"] or "Jak to działa" in n["parameters"]["content"]
            has_setup = "Setup" in n["parameters"]["content"] or "Konfiguracja" in n["parameters"]["content"]
            yield n["name"], words, has_how, has_setup


ok = True
for path in sorted(glob.glob(os.path.join(HERE, "workflows", "*.json"))):
    name = os.path.basename(path)
    iss = check_layout(path)
    if iss:
        ok = False
        print(f"❌ {name}")
        for i in iss:
            print(f"   - {i}")
    else:
        print(f"✅ {name} — layout OK")
    for sticky_name, words, has_how, has_setup in check_overview_words(path):
        flag = "✅" if (100 <= words <= 320 and has_how and has_setup) else "⚠️ "
        print(f"   {flag} overview '{sticky_name}': {words} words, How-it-works={has_how}, Setup={has_setup}")

print("\nRESULT:", "ALL OK" if ok else "ISSUES FOUND")
