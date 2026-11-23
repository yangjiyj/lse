from mcp.server.fastmcp import FastMCP

mcp = FastMCP("files", host="0.0.0.0", port=8000)


@mcp.tool()
def hello(name: str) -> str:
    """Say hello."""
    return f"hello {name}"


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
