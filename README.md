# Local YouTube Transcript

A small local web app for extracting YouTube caption tracks, with Japanese selected first when available.

The interface runs entirely on the local machine. Node.js serves the browser UI and calls an installed `yt-dlp` executable to discover and download caption tracks.

## Requirements

- Node.js 18 or newer
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) available on `PATH`

## Run

```powershell
npm start
```

Then open:

```text
http://localhost:4765
```

## What it does

- Reads caption metadata with `yt-dlp`.
- Uses uploaded captions when available, then falls back to auto captions.
- Defaults to Japanese (`ja`) if the video exposes Japanese captions.
- Outputs readable text, line-by-line text, timestamped text, SRT, VTT, or JSON.
- Lets you copy or download the transcript.

## Limits

Local YouTube Transcript retrieves caption tracks that `yt-dlp` can discover. It does not transcribe audio, so videos without captions return no transcript.
