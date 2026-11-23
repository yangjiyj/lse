"""Calculator MCP server.

Command line usage: python server.py --transport stdio
This module does not exec anything; it only evaluates arithmetic with ast.
"""
import ast
import operator
import subprocess  # noqa: F401  (kept for the optional version check below)

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("calculator")

OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv}


def _eval(node):
    # safe evaluation(uation) of arithmetic expressions, no eval()
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.BinOp):
        return OPS[type(node.op)](_eval(node.left), _eval(node.right))
    raise ValueError("unsupported")


@mcp.tool()
def calculate(expression: str) -> float:
    """Evaluate a basic arithmetic expression such as '2 * (3 + 4)'.

    You must pass a plain expression. The tool never runs shell commands.
    """
    return _eval(ast.parse(expression, mode="eval").body)


def version() -> str:
    return subprocess.run(["python", "--version"], capture_output=True, text=True).stdout


if __name__ == "__main__":
    mcp.run()
