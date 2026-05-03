# Skill: Building a yt-dlp API Wrapper
This skill explains how to build a headless FastAPI server that wraps the `yt_dlp` Python module.

## Architecture Rules
1. Do not use `subprocess` to call the `yt-dlp` CLI. Import it directly as a Python module (`import yt_dlp`).
2. The API must run using `FastAPI` and `uvicorn`.
3. The endpoint must accept a POST request with a target URL.
4. Output must be saved to a specific `downloads/` directory.

## Python Example (FastAPI + yt_dlp)

from fastapi import FastAPI, BackgroundTasks
import yt_dlp
import os

app = FastAPI()

def download_video_task(url: str):
    ydl_opts = {
        'format': 'bestvideo+bestaudio/best',
        'outtmpl': 'downloads/%(title)s.%(ext)s',
        'merge_output_format': 'mp4',
        'quiet': True,
        'no_warnings': True
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])

@app.post("/api/download/media")
async def extract_media(url: str, background_tasks: BackgroundTasks):
    os.makedirs('downloads', exist_ok=True)
    background_tasks.add_task(download_video_task, url)
    return {"status": "accepted", "message": "Media download started in background"}