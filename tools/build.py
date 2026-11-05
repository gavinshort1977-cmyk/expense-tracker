#!/usr/bin/env python3
"""Regenerate the service worker's file list and version.

Run this after changing any app file (not needed for config.js):
    python3 tools/build.py
"""
import hashlib, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INCLUDE_DIRS = ["js", "fonts", "icons", "vendor"]
INCLUDE_FILES = ["index.html", "manifest.webmanifest", "config.js"]
SKIP = re.compile(r"(\.map$|LICENSE|\.md$|\.DS_Store$|maskable\.svg$)")

def files():
    out = list(INCLUDE_FILES)
    for d in INCLUDE_DIRS:
        for base, _, names in os.walk(os.path.join(ROOT, d)):
            for n in names:
                rel = os.path.relpath(os.path.join(base, n), ROOT).replace(os.sep, "/")
                if not SKIP.search(rel):
                    out.append(rel)
    return sorted(set(out))

def main():
    fl = files()
    h = hashlib.sha256()
    for f in fl:
        if f == "config.js":
            continue  # config is fetched fresh anyway
        h.update(f.encode()); h.update(open(os.path.join(ROOT, f), "rb").read())
    version = h.hexdigest()[:12]
    listed = ["./"] + [f for f in fl if f != "index.html"]
    block = "// BUILD-START (generated, do not edit by hand)\nconst VERSION = %r;\nconst FILES = [\n%s\n];\n// BUILD-END" % (
        version, ",\n".join("  %r" % f for f in listed))
    block = block.replace("'", '"')
    p = os.path.join(ROOT, "sw.js")
    s = open(p).read()
    s2 = re.sub(r"// BUILD-START.*?// BUILD-END", lambda m: block, s, flags=re.S)
    open(p, "w").write(s2)
    print("sw.js updated: version %s, %d files" % (version, len(listed)))

if __name__ == "__main__":
    sys.exit(main())
