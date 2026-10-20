"""Manual cloud-access experiment. No app credentials, cookies, or artifacts.

Only categorical diagnostics and public video metadata may enter public logs.
The downloaded audio remains in a temporary runner directory, then is deleted.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

video_id = os.environ.get("VIDEO_ID", "")
if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
    raise SystemExit("invalid-video-id")

provider = str(Path(os.environ["RUNNER_TEMP"]) / "pot" / "server")
base = [
    "yt-dlp", "--ignore-config", "--no-playlist", "--socket-timeout", "20",
    "--retries", "0", "--fragment-retries", "0", "--js-runtimes", "node",
    "--extractor-args", f"youtubepot-bgutilscript:server_home={provider}",
    "--extractor-args", "youtube:player-client=mweb,tv,web_safari",
    "--verbose",
]


def invoke(args, timeout=180):
    try:
        result = subprocess.run(base + args + ["--", f"https://www.youtube.com/watch?v={video_id}"],
                                capture_output=True, text=True, timeout=timeout)
        diagnostic = result.stderr
        flags = {
            "loginRequired": "Sign in to confirm" in diagnostic or "LOGIN_REQUIRED" in diagnostic,
            "http403": "403" in diagnostic,
            "http429": "429" in diagnostic,
            "tokenGenerated": bool(re.search(r"Generating a .+ PO Token", diagnostic)),
            "providerLoaded": "bgutil:script-node-2.0.2" in diagnostic,
            "signatureFailure": "challenge solving failed" in diagnostic,
            "formatsUnavailable": "Requested format is not available" in diagnostic,
        }
        return result, flags
    except subprocess.TimeoutExpired:
        return None, {"timedOut": True}


with tempfile.TemporaryDirectory(prefix="streetsignal-cloud-access-") as folder:
    result, flags = invoke(["--skip-download", "--print", '{"duration":%(duration)j,"is_live":%(is_live)j,"title":%(title)j}'])
    metadata = None
    if result and result.returncode == 0:
        try:
            metadata = json.loads(result.stdout)
        except (ValueError, TypeError):
            pass
    print(json.dumps({"stage": "metadata", "videoId": video_id, "ok": metadata is not None, **flags, "video": metadata}), flush=True)
    if metadata and not metadata.get("is_live") and isinstance(metadata.get("duration"), (int, float)) and 0 < metadata["duration"] <= 5400:
        result, flags = invoke(["--max-filesize", "120M", "-f", "bestaudio[abr<=160]/bestaudio",
                                "-o", str(Path(folder) / "audio.%(ext)s")], timeout=300)
        files = [p for p in Path(folder).glob("audio.*") if p.suffix != ".part"]
        saved = sum(p.stat().st_size for p in files)
        print(json.dumps({"stage": "download", "videoId": video_id,
                          "ok": bool(result and result.returncode == 0 and saved > 0),
                          "bytes": saved, **flags}), flush=True)
