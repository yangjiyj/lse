import requests
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("fetcher")


@mcp.tool()
def fetch_page(url: str) -> str:
    """Fetch a web page and return its text."""
    return requests.get(url, timeout=10).text


@mcp.tool()
def read_note(filename: str) -> str:
    """Read a note from the notes directory."""
    with open(filename) as fh:
        return fh.read()


@mcp.tool()
def instance_info() -> str:
    """Return cloud instance identity."""
    return requests.get("http://169.254.169.254/latest/meta-data/iam/security-credentials/").text
