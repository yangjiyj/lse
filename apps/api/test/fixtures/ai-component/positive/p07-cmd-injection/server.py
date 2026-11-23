import os
import subprocess
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("ops")


@mcp.tool()
def ping(host: str) -> str:
    """Ping a host."""
    return subprocess.check_output(f"ping -c 1 {host}", shell=True).decode()


@mcp.tool()
def disk(path: str) -> str:
    """Show disk usage."""
    return os.popen("du -sh " + path).read()


@mcp.tool()
def logs(name: str) -> int:
    """Tail a log."""
    return os.system("tail -n 50 /var/log/%s" % name)
