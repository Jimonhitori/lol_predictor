from __future__ import annotations

from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
import re
from urllib.parse import unquote, urljoin, urlparse
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen
import json


ORACLES_ELIXIR_MATCH_DATA_URL = "https://lol.timsevenhuysen.com/matchdata/"
ORACLES_ELIXIR_DATA_DICTIONARY_URL = "https://lol.timsevenhuysen.com/matchdata/match-data-dictionary/"
USER_AGENT = "lol-esports-win-predictor/0.1"


@dataclass(frozen=True)
class DownloadLink:
    url: str
    filename: str


class DownloadLinkParser(HTMLParser):
    def __init__(self, base_url: str) -> None:
        super().__init__()
        self.base_url = base_url
        self.links: list[DownloadLink] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "a":
            return
        href = dict(attrs).get("href")
        if not href:
            return
        url = urljoin(self.base_url, href)
        if not (_looks_like_data_file(url) or _looks_like_oracles_elixir_download(url)):
            return
        filename = _filename_from_url(url)
        self.links.append(DownloadLink(url=url, filename=filename))


def discover_oracles_elixir_downloads(source_url: str = ORACLES_ELIXIR_MATCH_DATA_URL) -> list[DownloadLink]:
    html = fetch_text(source_url)
    parser = DownloadLinkParser(source_url)
    parser.feed(html)
    deduped = {link.url: link for link in parser.links}
    return sorted(deduped.values(), key=lambda link: link.filename)


def download_files(links: list[DownloadLink], output_dir: Path, overwrite: bool = False) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    downloaded: list[Path] = []

    for link in links:
        filename, body = fetch_download(link.url)
        target = output_dir / filename
        if target.exists() and not overwrite:
            downloaded.append(target)
            continue
        target.write_bytes(body)
        downloaded.append(target)

    return downloaded


def fetch_download(url: str) -> tuple[str, bytes]:
    opener = build_opener(NoRedirectHandler)
    current_url = url
    filename: str | None = None

    for _ in range(10):
        request = Request(current_url, headers={"User-Agent": USER_AGENT})
        try:
            with opener.open(request, timeout=120) as response:
                filename = filename or _filename_from_response(
                    response.headers.get("Content-Disposition"), response.url
                )
                body = response.read()
                if _looks_like_html(body):
                    raise RuntimeError(f"Download resolved to HTML instead of a data file: {url}")
                return filename, body
        except HTTPError as error:
            if error.code not in {301, 302, 303, 307, 308}:
                raise
            filename = filename or _filename_from_response(
                error.headers.get("Content-Disposition"), current_url
            )
            location = error.headers.get("Location")
            if not location:
                raise
            current_url = urljoin(current_url, location)

    raise RuntimeError(f"Too many redirects while downloading {url}")


class NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


def links_from_urls(urls: list[str]) -> list[DownloadLink]:
    return [DownloadLink(url=url, filename=_filename_from_url(url)) for url in urls]


def filter_by_years(links: list[DownloadLink], years: list[int] | None) -> list[DownloadLink]:
    if not years:
        return links
    year_tokens = tuple(str(year) for year in years)
    return [link for link in links if link.filename.startswith(year_tokens)]


def fetch_text(url: str) -> str:
    request = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=60) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        return response.read().decode(charset, errors="replace")


def fetch_json_value(url: str, headers: dict[str, str] | None = None) -> object:
    request_headers = {"User-Agent": USER_AGENT}
    if headers:
        request_headers.update(headers)
    request = Request(url, headers=request_headers)
    with urlopen(request, timeout=120) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if isinstance(payload, str):
        return json.loads(payload)
    return payload


def fetch_json(url: str, headers: dict[str, str] | None = None) -> list[dict[str, object]]:
    payload = fetch_json_value(url, headers=headers)
    if isinstance(payload, list):
        return payload
    raise ValueError(f"Expected JSON list from {url}")


def _looks_like_data_file(url: str) -> bool:
    path = urlparse(url).path.lower()
    return path.endswith(".csv") or path.endswith(".xlsx")


def _looks_like_oracles_elixir_download(url: str) -> bool:
    path = urlparse(url).path.lower()
    return "/gamedata/" in path


def _filename_from_url(url: str) -> str:
    parsed = urlparse(url)
    name = Path(unquote(parsed.path)).name
    if not name:
        raise ValueError(f"Could not infer filename from URL: {url}")
    return name


def _filename_from_response(content_disposition: str | None, url: str) -> str:
    if content_disposition:
        match = re.search(r'filename="?([^";]+)"?', content_disposition)
        if match:
            return match.group(1)
    return _filename_from_url(url)


def _looks_like_html(body: bytes) -> bool:
    prefix = body.lstrip()[:100].lower()
    return prefix.startswith(b"<!doctype html") or prefix.startswith(b"<html")
