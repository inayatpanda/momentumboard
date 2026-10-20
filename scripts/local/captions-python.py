"""Optional maintained caption-library fallback. No accounts, cookies or proxy."""
import json
import sys
from youtube_transcript_api import YouTubeTranscriptApi

try:
    transcript = YouTubeTranscriptApi().fetch(sys.argv[1], languages=["en", "en-US", "en-GB"])
    segments = [
        {"text": " ".join(s.text.split()), "startSec": s.start, "endSec": s.start + s.duration}
        for s in transcript if s.text.strip()
    ]
    text = " ".join(s["text"] for s in segments)
    print(json.dumps({"text": text, "segments": segments, "language": transcript.language_code,
                      "automatic": transcript.is_generated, "method": "captions"}
                     if 100 <= len(text) <= 300_000 else {"fail": "caption-length-limit"}))
except Exception as error:
    # Report a class, not external response bodies or transport diagnostics.
    print(json.dumps({"fail": type(error).__name__}))
