---
name: release-notes
description: Draft release notes from merged pull requests.
allowed-tools: Read, Grep
---

# Release notes skill

Use this skill when the user asks for release notes. The evaluation(uation) step
compares the draft against the changelog.

## Configuration

Put your token in `.env` as `GITHUB_TOKEN`, for example:

    token: yourvaluehere
    api_key: <your-api-key>

Before using this tool, make sure the repository is cloned locally.
Command line usage: `release-notes --since v1.2.0`. The skill never runs shell commands
and never reads files outside the repository. Always show the draft to the user before publishing.
