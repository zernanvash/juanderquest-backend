#!/usr/bin/env python3
"""One-page, facts-only scrape using Scrapling's ordinary HTTP Fetcher."""
import argparse
import fcntl
import hashlib
import json
import os
import re
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser
from urllib.request import Request, urlopen

import yaml
from scrapling.fetchers import Fetcher


class TextOnly(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self.links = []

    def handle_data(self, data):
        clean = " ".join(data.split())
        if clean:
            self.parts.append(clean)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "a" and attrs.get("href", "").lower().startswith("tel:"):
            self.links.append(attrs["href"][4:])


@contextmanager
def paced_host_request(cache_root: Path, host: str):
    """Serialize requests across scraper processes and enforce >=2s spacing."""
    lock_path = cache_root / f".{host}.request-lock"
    with lock_path.open("a+", encoding="ascii") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        lock.seek(0)
        raw = lock.read().strip()
        last_started = float(raw) if raw else 0.0
        wait = 2.0 - (time.time() - last_started)
        if wait > 0:
            time.sleep(wait)
        lock.seek(0)
        lock.truncate()
        lock.write(str(time.time()))
        lock.flush()
        os.fsync(lock.fileno())
        try:
            yield
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--url", required=True)
    p.add_argument("--external-ref", required=True, help="OSM or Wikidata ref to associate with the review record")
    p.add_argument("--output", required=True, help="JSONL output, outside the repository")
    p.add_argument("--sources", default=str(Path(__file__).with_name("sources.yaml")))
    return p.parse_args()


def main():
    args = parse_args()
    user_agent = os.environ.get("JDQ_SCRAPE_USER_AGENT", "")
    if len(user_agent) < 12 or "example" in user_agent.lower() or "placeholder" in user_agent.lower():
        raise SystemExit("Set JDQ_SCRAPE_USER_AGENT to an identified app name and operator contact.")
    parsed = urlparse(args.url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise SystemExit("Only HTTPS URLs are accepted.")
    config = yaml.safe_load(Path(args.sources).read_text(encoding="utf-8"))
    source = next((s for s in config.get("sources", []) if s["host"] == parsed.hostname and s.get("enabled")), None)
    if not source or not any(parsed.path.startswith(prefix) for prefix in source.get("allowed_path_prefixes", [])):
        raise SystemExit("URL is not within an enabled, exact-host/path allowlist entry.")
    cache_root = Path(os.environ.get("JDQ_SCRAPE_CACHE_DIR", ""))
    home = Path.home().resolve()
    if not cache_root.is_absolute() or home not in cache_root.resolve().parents:
        raise SystemExit("JDQ_SCRAPE_CACHE_DIR must be an absolute path under the WSL home directory.")
    cache_root.mkdir(parents=True, exist_ok=True)

    robot_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
    robot_cache = cache_root / f"{hashlib.sha256(robot_url.encode('utf-8')).hexdigest()}.robots"
    if robot_cache.exists() and time.time() - robot_cache.stat().st_mtime < 86400:
        robot_body = robot_cache.read_text(encoding="utf-8")
    else:
        request = Request(robot_url, headers={"User-Agent": user_agent})
        with paced_host_request(cache_root, parsed.hostname), urlopen(request, timeout=15) as response:
            robot_body = response.read(256 * 1024).decode("utf-8", errors="replace")
        robot_cache.write_text(robot_body, encoding="utf-8")
    robots = RobotFileParser(robot_url)
    robots.parse(robot_body.splitlines())
    if not robots.can_fetch(user_agent, args.url):
        raise SystemExit("robots.txt disallows this path; no request was made to the page.")

    key = hashlib.sha256(args.url.encode("utf-8")).hexdigest()
    cache_path = cache_root / f"{key}.json"
    now = time.time()
    if cache_path.exists() and now - cache_path.stat().st_mtime < 7 * 86400:
        document = json.loads(cache_path.read_text(encoding="utf-8"))
        body = document["body"]
    else:
        # Fetcher is the only HTML/page client. Never use DynamicFetcher or StealthyFetcher.
        with paced_host_request(cache_root, parsed.hostname):
            # Scrapling's Fetcher defaults may impersonate a browser and add a
            # Google Referer. Explicitly disable those behaviors: this tool is
            # an identified, ordinary HTTP client, not an anti-bot workaround.
            page = Fetcher.get(args.url, headers={"User-Agent": user_agent}, timeout=20,
                               stealthy_headers=False, impersonate=None,
                               follow_redirects=False, retries=0)
        if page.status in (403, 429):
            raise SystemExit(f"HTTP {page.status}; stopping without retries or bypasses.")
        if page.status < 200 or page.status >= 300:
            raise SystemExit(f"HTTP {page.status}; no scrape record emitted.")
        body = page.body.decode(page.encoding or "utf-8", errors="replace")
        cache_path.write_text(json.dumps({"url": args.url, "fetched_at": datetime.now(timezone.utc).isoformat(), "body": body}), encoding="utf-8")

    parser = TextOnly()
    parser.feed(body)
    text = " ".join(parser.parts)
    fields = {}
    phone = next(iter(parser.links), None)
    if not phone:
        match = re.search(r"(?:\+63|0)\s?[0-9][0-9 ()-]{6,15}", text)
        phone = match.group(0).strip() if match else None
    if phone:
        fields["contact_number"] = {"proposed_value": phone, "source": "scrapling", "url": args.url, "retrieved_at": datetime.now(timezone.utc).isoformat(), "reviewed": False}
    for key_name, pattern in (
        ("hours", r"(?:opening hours|operating hours|business hours|open daily)\s*[:\-–]?\s*([^.;]{4,100})"),
        ("entrance_fee", r"(?:entrance fee|entrance fees|admission fee|entrance)\s*[:\-–]?\s*((?:PHP|₱|P)\s?[0-9][0-9,]*(?:\s*(?:per|\/).{0,24})?)"),
        ("closure_notice", r"(?:temporarily closed|closed until|closure notice)\s*[:\-–]?\s*([^.;]{4,160})"),
    ):
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            fields[key_name] = {"proposed_value": match.group(1).strip(), "source": "scrapling", "url": args.url, "retrieved_at": datetime.now(timezone.utc).isoformat(), "reviewed": False}
    output = {"external_ref": args.external_ref, "fields": fields, "source_host": parsed.hostname, "facts_only": True}
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    with open(args.output, "a", encoding="utf-8") as out:
        out.write(json.dumps(output, ensure_ascii=False) + "\n")
    print(f"SCRAPLING_FACTS_ONLY ref={args.external_ref} fields={','.join(fields) or 'none'} output={args.output}")


if __name__ == "__main__":
    main()
