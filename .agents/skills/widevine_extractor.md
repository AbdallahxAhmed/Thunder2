# Skill: Handling DRM and Widevine using N_m3u8DL-RE
This skill dictates how the system handles explicit Widevine/DRM encrypted streams using `N_m3u8DL-RE`.

## Architecture Rules
1. `yt-dlp` cannot decrypt Widevine. If a stream is encrypted, the system must utilize `N_m3u8DL-RE`.
2. The required parameters are the MPD/M3U8 Manifest URL and the `KID:KEY` pair.
3. The system should execute `N_m3u8DL-RE` via `subprocess.run` to handle the downloading, decrypting, and muxing.

## Python Example (Execution)
import subprocess
import os

def download_encrypted_stream(manifest_url: str, key_string: str, output_name: str):
    """
    key_string must be formatted as KID:KEY (e.g., '1234...:abcd...')
    """
    os.makedirs('downloads', exist_ok=True)
    
    command = [
        "N_m3u8DL-RE",
        manifest_url,
        "--key", key_string,
        "--save-dir", "downloads",
        "--save-name", output_name,
        "--auto-select", # Automatically select best tracks
        "--del-after-done" # Clean up temp chunks
    ]
    
    # Run the process
    process = subprocess.run(command, capture_output=True, text=True)
    
    if process.returncode == 0:
        return {"status": "success", "file": f"{output_name}.mp4"}
    else:
        return {"status": "error", "logs": process.stderr}