# Skill: Interfacing with aria2 RPC
This skill provides the required knowledge to build a client that interacts with an `aria2c` daemon via JSON-RPC.

## Architecture Rules
1. The `aria2c` daemon must be run with `--enable-rpc=true` and a secret token `--rpc-secret=YOUR_TOKEN`.
2. All API calls must be made via HTTP POST to `http://localhost:6800/jsonrpc`.
3. The payload must be a valid JSON-RPC 2.0 object.

## Python Example (Adding a Download)

import json
import requests

def add_download(url, rpc_secret="YOUR_TOKEN"):
    rpc_endpoint = "http://localhost:6800/jsonrpc"
    payload = {
        "jsonrpc": "2.0",
        "id": "dark-downloader",
        "method": "aria2.addUri",
        "params": [
            f"token:{rpc_secret}",
            [url],
            {
                "split": "16",
                "max-connection-per-server": "16",
                "min-split-size": "1M"
            }
        ]
    }
    response = requests.post(rpc_endpoint, json=payload)
    return response.json()