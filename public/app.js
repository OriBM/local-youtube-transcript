const refs = {
  form: document.querySelector("#urlForm"),
  urlInput: document.querySelector("#urlInput"),
  inspectButton: document.querySelector("#inspectButton"),
  fetchButton: document.querySelector("#fetchButton"),
  trackSelect: document.querySelector("#trackSelect"),
  formatSelect: document.querySelector("#formatSelect"),
  removeNoise: document.querySelector("#removeNoise"),
  status: document.querySelector("#status"),
  player: document.querySelector("#player"),
  emptyVideo: document.querySelector("#emptyVideo"),
  videoMeta: document.querySelector("#videoMeta"),
  thumbnail: document.querySelector("#thumbnail"),
  videoTitle: document.querySelector("#videoTitle"),
  videoChannel: document.querySelector("#videoChannel"),
  trackInfo: document.querySelector("#trackInfo"),
  outputText: document.querySelector("#outputText"),
  copyButton: document.querySelector("#copyButton"),
  downloadButton: document.querySelector("#downloadButton"),
  cueList: document.querySelector("#cueList"),
  cueCount: document.querySelector("#cueCount")
};

const state = {
  info: null,
  transcript: null,
  currentOutput: ""
};

refs.form.addEventListener("submit", event => {
  event.preventDefault();
  inspectVideo();
});

refs.fetchButton.addEventListener("click", fetchTranscript);
refs.formatSelect.addEventListener("change", renderOutput);
refs.removeNoise.addEventListener("change", renderOutput);
refs.copyButton.addEventListener("click", copyTranscript);
refs.downloadButton.addEventListener("click", downloadTranscript);
refs.trackSelect.addEventListener("change", () => {
  if (state.transcript) refs.fetchButton.disabled = false;
});

renderEmptyCues();

async function inspectVideo() {
  const url = refs.urlInput.value.trim();
  if (!url) return;

  setBusy("Checking");
  refs.fetchButton.disabled = true;
  refs.trackSelect.disabled = true;
  refs.trackSelect.innerHTML = "<option>Loading captions...</option>";

  try {
    const info = await postJson("/api/inspect", { url });
    state.info = info;
    state.transcript = null;
    hydrateVideo(info.video);
    hydrateTracks(info.tracks, info.preferred);
    refs.outputText.value = "";
    refs.trackInfo.textContent = "Choose a caption track, then fetch the transcript.";
    refs.copyButton.disabled = true;
    refs.downloadButton.disabled = true;
    renderEmptyCues();
    setDone("Captions found");
  } catch (error) {
    setError(error.message);
    refs.trackSelect.innerHTML = "<option>No captions loaded</option>";
  }
}

async function fetchTranscript() {
  const url = refs.urlInput.value.trim();
  const selected = parseTrackValue(refs.trackSelect.value);
  if (!url || !selected) return;

  setBusy("Fetching");
  refs.fetchButton.disabled = true;

  try {
    const transcript = await postJson("/api/transcript", {
      url,
      source: selected.source,
      language: selected.code
    });
    state.transcript = transcript;
    state.info = state.info || { video: transcript.video };
    hydrateVideo(transcript.video);
    refs.trackInfo.textContent = `${transcript.track.name} · ${transcript.track.sourceLabel} · ${transcript.sourceFormat.toUpperCase()}`;
    refs.copyButton.disabled = false;
    refs.downloadButton.disabled = false;
    renderOutput();
    renderCues();
    setDone(`${transcript.cues.length} lines`);
  } catch (error) {
    setError(error.message);
  } finally {
    refs.fetchButton.disabled = false;
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok || payload.error) {
    throw new Error(payload.error || "Request failed.");
  }
  return payload;
}

function hydrateVideo(video) {
  refs.emptyVideo.hidden = true;
  refs.player.hidden = false;
  refs.videoMeta.hidden = false;
  refs.player.src = `${video.embedUrl}?rel=0`;
  refs.thumbnail.src = video.thumbnail;
  refs.thumbnail.alt = "";
  refs.videoTitle.textContent = video.title;
  refs.videoChannel.textContent = [
    video.channel,
    video.duration ? formatDuration(video.duration * 1000) : ""
  ].filter(Boolean).join(" · ");
}

function hydrateTracks(tracks, preferred) {
  const manual = tracks.manual || [];
  const auto = tracks.auto || [];
  const all = [...manual, ...auto];

  refs.trackSelect.innerHTML = "";
  if (!all.length) {
    refs.trackSelect.innerHTML = "<option>No captions available</option>";
    refs.trackSelect.disabled = true;
    refs.fetchButton.disabled = true;
    return;
  }

  addTrackGroup("Uploaded captions", manual);
  addTrackGroup("Auto captions", auto);

  const preferredValue = preferred ? trackValue(preferred) : trackValue(all[0]);
  refs.trackSelect.value = preferredValue;
  refs.trackSelect.disabled = false;
  refs.fetchButton.disabled = false;
}

function addTrackGroup(label, tracks) {
  if (!tracks.length) return;
  const group = document.createElement("optgroup");
  group.label = label;
  for (const track of tracks) {
    const option = document.createElement("option");
    option.value = trackValue(track);
    option.textContent = `${track.name} (${track.code})`;
    group.append(option);
  }
  refs.trackSelect.append(group);
}

function trackValue(track) {
  return `${track.source}|${track.code}`;
}

function parseTrackValue(value) {
  const [source, code] = String(value || "").split("|");
  if (!source || !code) return null;
  return { source, code };
}

function renderOutput() {
  if (!state.transcript) return;
  const cues = filteredCues();
  const format = refs.formatSelect.value;
  const output = format === "readable" ? toReadableText(cues) :
    format === "lines" ? cues.map(cue => cue.text).join("\n") :
    format === "timestamped" ? cues.map(cue => `[${formatShortTime(cue.startMs)}] ${cue.text}`).join("\n") :
    format === "srt" ? toSrt(cues) :
    format === "vtt" ? toVtt(cues) :
    JSON.stringify(cues, null, 2);

  state.currentOutput = output;
  refs.outputText.value = output;
  refs.cueCount.textContent = `${cues.length} lines`;
}

function filteredCues() {
  const cues = state.transcript?.cues || [];
  if (!refs.removeNoise.checked) return cues;
  return cues.filter(cue => !/^\s*[\[(][^\])]{1,40}[\])]\s*$/.test(cue.text));
}

function toReadableText(cues) {
  const paragraphs = [];
  let paragraph = "";
  let lastEnd = 0;

  for (const cue of cues) {
    const text = cue.text.trim();
    if (!text) continue;

    if (paragraph && cue.startMs - lastEnd > 2600) {
      paragraphs.push(paragraph.trim());
      paragraph = "";
    }

    paragraph = joinCaptionText(paragraph, text);
    if (/[。！？!?]\s*$/.test(text)) {
      paragraphs.push(paragraph.trim());
      paragraph = "";
    }
    lastEnd = cue.endMs;
  }

  if (paragraph.trim()) paragraphs.push(paragraph.trim());
  return paragraphs.join("\n\n");
}

function joinCaptionText(current, next) {
  if (!current) return next;
  const end = current.slice(-1);
  const start = next.charAt(0);
  const cjk = /[\u3040-\u30ff\u3400-\u9fff]/;
  const punctuation = /^[、。！？!?.,;:)\]}]/;
  const needsNoSpace = cjk.test(end) || cjk.test(start) || punctuation.test(next);
  return `${current}${needsNoSpace ? "" : " "}${next}`;
}

function toSrt(cues) {
  return cues.map((cue, index) => [
    index + 1,
    `${formatSrtTime(cue.startMs)} --> ${formatSrtTime(cue.endMs)}`,
    cue.text,
    ""
  ].join("\n")).join("\n");
}

function toVtt(cues) {
  return `WEBVTT\n\n${cues.map(cue => [
    `${formatVttTime(cue.startMs)} --> ${formatVttTime(cue.endMs)}`,
    cue.text,
    ""
  ].join("\n")).join("\n")}`;
}

function renderCues() {
  const cues = filteredCues();
  refs.cueList.innerHTML = "";
  if (!cues.length) {
    renderEmptyCues();
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const cue of cues) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "cue-row";
    row.addEventListener("click", () => seekToCue(cue));

    const time = document.createElement("span");
    time.className = "cue-time";
    time.textContent = formatShortTime(cue.startMs);

    const text = document.createElement("span");
    text.className = "cue-text";
    text.textContent = cue.text;

    row.append(time, text);
    fragment.append(row);
  }
  refs.cueList.append(fragment);
}

function renderEmptyCues() {
  refs.cueCount.textContent = "0 lines";
  refs.cueList.innerHTML = '<div class="empty-state">Caption lines will appear here.</div>';
}

function seekToCue(cue) {
  const video = state.transcript?.video || state.info?.video;
  if (!video) return;
  const start = Math.max(0, Math.floor(cue.startMs / 1000));
  refs.player.src = `${video.embedUrl}?start=${start}&autoplay=1&rel=0`;
}

async function copyTranscript() {
  if (!state.currentOutput) return;
  await navigator.clipboard.writeText(state.currentOutput);
  setDone("Copied");
}

function downloadTranscript() {
  if (!state.currentOutput) return;
  const format = refs.formatSelect.value;
  const ext = format === "srt" ? "srt" : format === "vtt" ? "vtt" : format === "json" ? "json" : "txt";
  const mime = ext === "json" ? "application/json" : "text/plain";
  const title = state.transcript?.video?.title || "youtube-transcript";
  const track = state.transcript?.track?.code || "captions";
  const filename = `${safeFilename(title)}.${track}.${ext}`;
  const blob = new Blob([state.currentOutput], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function safeFilename(value) {
  return String(value || "youtube-transcript")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90) || "youtube-transcript";
}

function formatShortTime(ms) {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ?
    `${hours}:${pad(minutes)}:${pad(seconds)}` :
    `${minutes}:${pad(seconds)}`;
}

function formatDuration(ms) {
  return formatShortTime(ms);
}

function formatSrtTime(ms) {
  return formatClock(ms, ",");
}

function formatVttTime(ms) {
  return formatClock(ms, ".");
}

function formatClock(ms, separator) {
  const clamped = Math.max(0, Math.round(ms));
  const hours = Math.floor(clamped / 3_600_000);
  const minutes = Math.floor((clamped % 3_600_000) / 60_000);
  const seconds = Math.floor((clamped % 60_000) / 1000);
  const millis = clamped % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${separator}${String(millis).padStart(3, "0")}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function setBusy(message) {
  setStatus(message, "busy");
}

function setDone(message) {
  setStatus(message, "done");
}

function setError(message) {
  setStatus(message, "error");
  refs.trackInfo.textContent = message;
}

function setStatus(message, className) {
  refs.status.textContent = message;
  refs.status.className = `status-pill ${className || ""}`.trim();
}
