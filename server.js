const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs/promises");
const { spawn } = require("node:child_process");

const PORT = Number(process.env.PORT || 4765);
const PUBLIC_DIR = path.join(__dirname, "public");
const CACHE_TTL_MS = 10 * 60 * 1000;

const infoCache = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

const sourceLabels = {
  manual: "Uploaded captions",
  auto: "Auto captions"
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendError(res, status, message, details) {
  sendJson(res, status, { error: message, details: details || undefined });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body is too large."));
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Expected a JSON request body."));
      }
    });
    req.on("error", reject);
  });
}

function isYouTubeHost(hostname) {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return host === "youtube.com" ||
    host === "youtu.be" ||
    host === "music.youtube.com" ||
    host === "m.youtube.com" ||
    host.endsWith(".youtube.com");
}

function extractVideoId(input) {
  const value = String(input || "").trim();
  if (!value) return null;

  const bareId = value.match(/^[a-zA-Z0-9_-]{11}$/);
  if (bareId) return bareId[0];

  try {
    const url = new URL(value);
    if (!isYouTubeHost(url.hostname)) return null;

    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "youtu.be") {
      return cleanVideoId(url.pathname.split("/").filter(Boolean)[0]);
    }

    const watchId = cleanVideoId(url.searchParams.get("v"));
    if (watchId) return watchId;

    const parts = url.pathname.split("/").filter(Boolean);
    const keyedPaths = new Set(["embed", "shorts", "live"]);
    if (keyedPaths.has(parts[0])) return cleanVideoId(parts[1]);
  } catch {
    return null;
  }

  return null;
}

function cleanVideoId(value) {
  if (!value) return null;
  const match = String(value).match(/[a-zA-Z0-9_-]{11}/);
  return match ? match[0] : null;
}

function normalizeInputUrl(input) {
  const videoId = extractVideoId(input);
  if (!videoId) {
    throw new Error("Paste a YouTube video URL or video ID.");
  }
  return {
    videoId,
    watchUrl: `https://www.youtube.com/watch?v=${videoId}`,
    embedUrl: `https://www.youtube.com/embed/${videoId}`
  };
}

function runYtDlp(args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("YouTube took too long to respond. Try again in a moment."));
    }, timeoutMs);

    child.stdout.on("data", chunk => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", chunk => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", error => {
      clearTimeout(timer);
      if (error.code === "ENOENT") {
        reject(new Error("yt-dlp is not installed or is not available on this computer."));
      } else {
        reject(error);
      }
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout);
      reject(new Error(cleanProcessError(stderr) || `yt-dlp exited with code ${code}.`));
    });
  });
}

function cleanProcessError(stderr) {
  return String(stderr || "")
    .split(/\r?\n/)
    .map(line => line.replace(/^ERROR:\s*/i, "").trim())
    .filter(Boolean)
    .slice(-3)
    .join(" ");
}

async function getVideoInfo(input) {
  const normalized = normalizeInputUrl(input);
  const cached = infoCache.get(normalized.videoId);
  if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
    return cached.value;
  }

  const stdout = await runYtDlp([
    "--dump-single-json",
    "--skip-download",
    "--no-warnings",
    "--no-playlist",
    normalized.watchUrl
  ]);

  const info = JSON.parse(stdout);
  const value = {
    raw: info,
    video: {
      id: normalized.videoId,
      title: info.title || "Untitled video",
      channel: info.channel || info.uploader || "",
      duration: Number(info.duration || 0),
      thumbnail: info.thumbnail || `https://img.youtube.com/vi/${normalized.videoId}/hqdefault.jpg`,
      watchUrl: normalized.watchUrl,
      embedUrl: normalized.embedUrl
    },
    tracks: getTracks(info, true)
  };

  infoCache.set(normalized.videoId, { savedAt: Date.now(), value });
  return value;
}

function getTracks(info, includeUrls = false) {
  const manual = mapTrackBucket(info.subtitles, "manual", includeUrls);
  const auto = mapTrackBucket(info.automatic_captions, "auto", includeUrls);
  return { manual, auto };
}

function mapTrackBucket(bucket, source, includeUrls) {
  return Object.entries(bucket || {})
    .filter(([, formats]) => Array.isArray(formats) && formats.length)
    .map(([code, formats]) => {
      const usableFormats = formats
        .filter(format => format && format.url)
        .map(format => ({
          ext: format.ext || "",
          name: format.name || "",
          language: format.language || "",
          formatId: format.format_id || "",
          url: includeUrls ? format.url : undefined
        }));

      const name = usableFormats.find(format => format.name)?.name ||
        usableFormats.find(format => format.language)?.language ||
        languageNameFromCode(code);

      return {
        code,
        name,
        source,
        sourceLabel: sourceLabels[source],
        exts: [...new Set(usableFormats.map(format => format.ext).filter(Boolean))],
        formats: includeUrls ? usableFormats : undefined
      };
    })
    .sort((a, b) => scoreTrack(a) - scoreTrack(b) || a.name.localeCompare(b.name));
}

function scoreTrack(track) {
  const code = track.code.toLowerCase();
  if (code === "ja") return 0;
  if (code.startsWith("ja-")) return 1;
  if (code === "en") return 2;
  return 10;
}

function languageNameFromCode(code) {
  try {
    const displayNames = new Intl.DisplayNames(["en"], { type: "language" });
    return displayNames.of(code.split("-")[0]) || code;
  } catch {
    return code;
  }
}

function publicTracks(tracks) {
  return {
    manual: tracks.manual.map(publicTrack),
    auto: tracks.auto.map(publicTrack)
  };
}

function publicTrack(track) {
  return {
    code: track.code,
    name: track.name,
    source: track.source,
    sourceLabel: track.sourceLabel,
    exts: track.exts
  };
}

function flattenTracks(tracks) {
  return [...tracks.manual, ...tracks.auto];
}

function chooseTrack(tracks, requestedSource, requestedLanguage) {
  const all = flattenTracks(tracks);
  if (!all.length) return null;

  if (requestedSource && requestedLanguage) {
    const exact = all.find(track =>
      track.source === requestedSource &&
      track.code.toLowerCase() === requestedLanguage.toLowerCase()
    );
    if (exact) return exact;
  }

  const language = String(requestedLanguage || "ja").toLowerCase();
  const sources = requestedSource ? [requestedSource] : ["manual", "auto"];
  const ordered = sources.flatMap(source => all.filter(track => track.source === source));

  return ordered.find(track => track.code.toLowerCase() === language) ||
    ordered.find(track => track.code.toLowerCase().startsWith(`${language}-`)) ||
    ordered.find(track => track.code.toLowerCase().split("-")[0] === language.split("-")[0]) ||
    ordered[0] ||
    null;
}

function chooseCaptionFormat(track) {
  const formats = track.formats || [];
  const preference = ["json3", "vtt", "ttml", "srv3", "srv2", "srv1"];
  for (const ext of preference) {
    const found = formats.find(format => String(format.ext).toLowerCase() === ext && format.url);
    if (found) return found;
  }
  return formats.find(format => format.url) || null;
}

async function fetchCaption(format) {
  const response = await fetch(format.url, {
    headers: {
      "user-agent": "Mozilla/5.0 LocalTranscriptTool/1.0"
    }
  });
  if (!response.ok) {
    throw new Error(`Could not fetch the caption file (${response.status}).`);
  }
  return response.text();
}

function parseCaption(content, ext) {
  const normalizedExt = String(ext || "").toLowerCase();
  if (normalizedExt === "json3") return parseJson3(content);
  if (normalizedExt === "vtt") return parseVtt(content);
  if (normalizedExt === "ttml") return parseTtml(content);
  if (normalizedExt.startsWith("srv")) return parseSrv(content);

  const trimmed = String(content || "").trim();
  if (trimmed.startsWith("{")) return parseJson3(content);
  if (/^WEBVTT/i.test(trimmed)) return parseVtt(content);
  if (/<text\b/i.test(trimmed)) return parseSrv(content);
  if (/<tt\b/i.test(trimmed)) return parseTtml(content);

  return [];
}

function parseJson3(content) {
  const data = JSON.parse(content);
  return (data.events || [])
    .map(event => {
      const text = (event.segs || [])
        .map(segment => segment.utf8 || "")
        .join("");
      return makeCue(event.tStartMs, Number(event.tStartMs || 0) + Number(event.dDurationMs || 0), text);
    })
    .filter(Boolean);
}

function parseVtt(content) {
  const lines = String(content || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  const cues = [];
  let i = 0;

  while (i < lines.length) {
    let line = lines[i].trim();
    if (!line || /^WEBVTT/i.test(line)) {
      i += 1;
      continue;
    }

    if (/^(NOTE|STYLE|REGION)\b/i.test(line)) {
      i += 1;
      while (i < lines.length && lines[i].trim()) i += 1;
      continue;
    }

    if (!line.includes("-->") && i + 1 < lines.length && lines[i + 1].includes("-->")) {
      i += 1;
      line = lines[i].trim();
    }

    if (!line.includes("-->")) {
      i += 1;
      continue;
    }

    const [startRaw, endRaw] = line.split("-->").map(part => part.trim().split(/\s+/)[0]);
    i += 1;
    const textLines = [];
    while (i < lines.length && lines[i].trim()) {
      textLines.push(lines[i]);
      i += 1;
    }
    const cue = makeCue(parseTimestamp(startRaw), parseTimestamp(endRaw), textLines.join("\n"));
    if (cue) cues.push(cue);
  }

  return cues;
}

function parseTtml(content) {
  const cues = [];
  const body = String(content || "");
  const pattern = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  let match;
  while ((match = pattern.exec(body))) {
    const attrs = match[1];
    const start = readTimeAttr(attrs, "begin");
    const end = readTimeAttr(attrs, "end");
    const dur = readTimeAttr(attrs, "dur");
    const cue = makeCue(start, end || start + dur, match[2]);
    if (cue) cues.push(cue);
  }
  return cues;
}

function parseSrv(content) {
  const cues = [];
  const body = String(content || "");
  const pattern = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  let match;
  while ((match = pattern.exec(body))) {
    const attrs = match[1];
    const start = Number(readXmlAttr(attrs, "start") || 0) * 1000;
    const dur = Number(readXmlAttr(attrs, "dur") || 0) * 1000;
    const cue = makeCue(start, start + dur, match[2]);
    if (cue) cues.push(cue);
  }
  return cues;
}

function readTimeAttr(attrs, name) {
  const value = readXmlAttr(attrs, name);
  return value ? parseTimestamp(value) : 0;
}

function readXmlAttr(attrs, name) {
  const pattern = new RegExp(`${name}=["']([^"']+)["']`, "i");
  const match = String(attrs || "").match(pattern);
  return match ? match[1] : "";
}

function parseTimestamp(value) {
  const text = String(value || "").trim().replace(",", ".");
  if (!text) return 0;

  const clock = text.match(/(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.(\d+))?/);
  if (clock) {
    const hours = Number(clock[1] || 0);
    const minutes = Number(clock[2] || 0);
    const seconds = Number(clock[3] || 0);
    const fraction = Number(`0.${clock[4] || 0}`);
    return Math.round(((hours * 3600) + (minutes * 60) + seconds + fraction) * 1000);
  }

  const unit = text.match(/^([\d.]+)(ms|s|m|h)?$/i);
  if (!unit) return 0;
  const amount = Number(unit[1] || 0);
  const suffix = (unit[2] || "s").toLowerCase();
  if (suffix === "ms") return Math.round(amount);
  if (suffix === "m") return Math.round(amount * 60_000);
  if (suffix === "h") return Math.round(amount * 3_600_000);
  return Math.round(amount * 1000);
}

function makeCue(startMs, endMs, text) {
  const start = Math.max(0, Number(startMs || 0));
  const end = Math.max(start + 1, Number(endMs || start + 1));
  const clean = cleanCaptionText(text);
  if (!clean) return null;
  return {
    startMs: Math.round(start),
    endMs: Math.round(end),
    text: clean
  };
}

function cleanCaptionText(text) {
  return decodeEntities(String(text || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?[^>]+>/g, "")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim());
}

function decodeEntities(text) {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    nbsp: " "
  };
  return String(text || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, body) => {
    const lower = body.toLowerCase();
    if (lower[0] === "#") {
      const code = lower[1] === "x" ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
    }
    return Object.prototype.hasOwnProperty.call(named, lower) ? named[lower] : entity;
  });
}

function stripInternalTrack(track) {
  return publicTrack(track);
}

async function handleInspect(req, res) {
  const body = await readBody(req);
  const info = await getVideoInfo(body.url);
  sendJson(res, 200, {
    video: info.video,
    tracks: publicTracks(info.tracks),
    preferred: stripInternalTrack(chooseTrack(info.tracks, null, "ja"))
  });
}

async function handleTranscript(req, res) {
  const body = await readBody(req);
  const info = await getVideoInfo(body.url);
  const track = chooseTrack(info.tracks, body.source, body.language || "ja");
  if (!track) {
    throw new Error("This video does not expose any captions.");
  }

  const format = chooseCaptionFormat(track);
  if (!format) {
    throw new Error(`No readable caption file was found for ${track.name}.`);
  }

  const captionText = await fetchCaption(format);
  const cues = mergeDuplicateCues(parseCaption(captionText, format.ext));

  if (!cues.length) {
    throw new Error(`The ${track.name} caption file was empty or could not be parsed.`);
  }

  sendJson(res, 200, {
    video: info.video,
    track: stripInternalTrack(track),
    sourceFormat: format.ext,
    cues
  });
}

function mergeDuplicateCues(cues) {
  const result = [];
  for (const cue of cues) {
    const previous = result[result.length - 1];
    if (previous &&
      previous.text === cue.text &&
      Math.abs(previous.startMs - cue.startMs) < 250 &&
      Math.abs(previous.endMs - cue.endMs) < 250) {
      continue;
    }
    result.push(cue);
  }
  return result;
}

async function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const safePath = path.normalize(decodeURIComponent(requestUrl.pathname)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath === "/" ? "index.html" : safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    const finalPath = stat.isDirectory() ? path.join(filePath, "index.html") : filePath;
    const body = await fs.readFile(finalPath);
    res.writeHead(200, {
      "content-type": mimeTypes[path.extname(finalPath).toLowerCase()] || "application/octet-stream"
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/inspect") {
      await handleInspect(req, res);
      return;
    }
    if (req.method === "POST" && req.url === "/api/transcript") {
      await handleTranscript(req, res);
      return;
    }
    if (req.method === "GET") {
      await serveStatic(req, res);
      return;
    }
    sendError(res, 405, "Method not allowed.");
  } catch (error) {
    sendError(res, 400, error.message || "Something went wrong.");
  }
});

server.listen(PORT, () => {
  console.log(`Local YouTube Transcript is running at http://localhost:${PORT}`);
});
