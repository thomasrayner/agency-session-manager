#!/usr/bin/env pwsh
# Instant, AI-free TUI session picker. Launches the interactive overlay.
# Usage: picksession.ps1 [args...]   (any args are passed through to the CLI)
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
node (Join-Path $here 'session-manager.mjs') @args
