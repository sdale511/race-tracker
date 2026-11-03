# PlatformIO pre-script: the firmware's version, worked out from git the way src/version.js does for the Node rover -
# package.json's major.minor, then the commit count ("v0.1.290"), with the short hash, the commit date and "+ local changes"
# when tracked files are modified. Sets ROVER_VERSION (the startup line), ROVER_BUILD (the status hello's build number) and
# ROVER_DIRTY. Without git it is package.json's version as it stands.
import json
import os
import subprocess

Import("env")  # noqa: F821 - PlatformIO's SCons environment

repo = os.path.normpath(os.path.join(env.subst("$PROJECT_DIR"), "..", ".."))  # noqa: F821


def git(*args):
    try:
        return subprocess.check_output(["git", *args], cwd=repo, stderr=subprocess.DEVNULL, timeout=3).decode().strip()
    except Exception:
        return None


try:
    with open(os.path.join(repo, "package.json")) as f:
        pkg = json.load(f)["version"]
except Exception:
    pkg = "0.0.0"
major, minor = (pkg.split(".") + ["0", "0"])[:2]
count = git("rev-list", "--count", "HEAD")
commit = git("rev-parse", "--short", "HEAD")
if count and count.isdigit() and commit:
    date = git("log", "-1", "--format=%cs")
    dirty = bool(git("status", "--porcelain", "--untracked-files=no"))
    details = ", ".join(x for x in (commit, date) if x)
    label = f"v{major}.{minor}.{count} ({details})" + (" + local changes" if dirty else "")
    build = int(count)
else:
    dirty = False
    label = f"v{pkg}"
    build = 0

env.Append(CPPDEFINES=[("ROVER_VERSION", env.StringifyMacro(label)), ("ROVER_BUILD", build), ("ROVER_DIRTY", int(dirty))])  # noqa: F821
# the checkout, for host_rover's race-config/boat_id.txt (the Node rover's stored id)
env.Append(CPPDEFINES=[("ROVER_REPO_DIR", env.StringifyMacro(repo))])  # noqa: F821
print(f"race-tracker {label}")
