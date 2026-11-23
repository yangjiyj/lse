import os
import subprocess
from pathlib import Path

import httpx
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("git-helper")
ROOT = Path(os.environ.get("REPO_ROOT", ".")).resolve()
ALLOWED_HOSTS = {"api.github.com"}


@mcp.tool()
def git_status() -> str:
    """Show `git status` for the configured repository."""
    return subprocess.run(["git", "status", "--short"], cwd=ROOT, capture_output=True, text=True).stdout


@mcp.tool()
def read_file(relative_path: str) -> str:
    """Read a file inside the repository."""
    target = (ROOT / relative_path).resolve()
    if not target.is_relative_to(ROOT):
        raise ValueError("path outside repository")
    return target.read_text()


@mcp.tool()
def repo_info(owner: str, repo: str) -> str:
    """Fetch public repository metadata from GitHub."""
    token = os.environ.get("GITHUB_TOKEN", "")
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return httpx.get(f"https://api.github.com/repos/{owner}/{repo}", headers=headers).text
