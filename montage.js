// Eggball montage page. Plain JavaScript, no libraries. data.json holds small clips cut from real replays
// (positions of every player, the egg, the score), and this page redraws them with the real eggball textures.
// Positions are in units; one tile is 0.4 units. The picture is drawn at 50 pixels per unit.

const PIXELS_PER_UNIT = 50;
const PLAYER_RADIUS_UNITS = 0.19;
const TILE_UNITS = 0.4;
// replay positions put the centre of tile (column, row) at (column, row) * 0.4, so moving things are drawn
// half a tile down and right of the map's own corner
const ENTITY_OFFSET = TILE_UNITS * PIXELS_PER_UNIT / 2;
const GAME_VIEW_TILES_HIGH = 20;     // the game's watch camera shows 20 tiles from top to bottom at zoom 1
const PAUSE_BETWEEN_CLIPS_MS = 700;

const mapCanvas = document.getElementById('map-canvas');
const drawing = mapCanvas.getContext('2d');
const playPauseButton = document.getElementById('play-pause-button');
const playAllCheckbox = document.getElementById('play-all-checkbox');
const speedSelect = document.getElementById('speed-select');
const viewSelect = document.getElementById('view-select');
const kindSelect = document.getElementById('kind-select');
const captionDiv = document.getElementById('clip-caption');
const clipList = document.getElementById('clip-list');

let data = null;             // data.json
let shownClips = [];         // the clips that pass the kind filter, newest first
let clipIndex = 0;           // index into shownClips
let clip = null;             // the clip being played, ready for drawing (see prepareClip)
let currentMs = 0;
let playing = true;
let lastFrameClock = null;
let waitedMs = 0;            // time spent paused at the end of a clip
let view = { scale: 1, offsetX: 0, offsetY: 0 };
let smoothedCentre = null;

// ---------- the real textures ----------

function loadImage(name) {
  const image = new Image();
  image.src = 'art/' + name;
  image.onload = () => draw();
  return image;
}
const redBallImage = loadImage('ball-red.png');
const blueBallImage = loadImage('ball-blue.png');
const eggImage = loadImage('egg.png');
const fieldImages = {};
function fieldImageFor(name) {
  if (!name) return null;
  if (!fieldImages[name]) fieldImages[name] = loadImage(name + '.png');
  return fieldImages[name];
}
function imageReady(image) { return image && image.complete && image.naturalWidth > 0; }

// ---------- getting a clip ready ----------

function prepareClip(raw) {
  const prepared = {
    raw: raw, team: {}, name: {}, sampleTimes: {}, samples: {}, deadChanges: {},
    rows: data.maps[raw.art].map(row => Array.from(row)),
  };
  for (const [id, name, team] of raw.players) { prepared.team[id] = team; prepared.name[id] = name; }
  for (const id in raw.samples) {
    prepared.sampleTimes[id] = raw.samples[id].map(s => s[0]);
    prepared.samples[id] = raw.samples[id].map(s => [s[1], s[2], s[3], s[4]]);
    prepared.deadChanges[id] = raw.dead[id] || [];
  }
  return prepared;
}

// ---------- looking things up at a time ----------

function lastIndexAtOrBefore(list, ms, getTime) {
  let low = 0, high = list.length - 1, found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (getTime(list[mid]) <= ms) { found = mid; low = mid + 1; } else { high = mid - 1; }
  }
  return found;
}

function playerPosition(id, ms) {
  const times = clip.sampleTimes[id];
  if (!times) return null;
  const i = Math.max(lastIndexAtOrBefore(times, ms, t => t), 0);
  const [x, y, vx, vy] = clip.samples[id][i];
  if (i + 1 < times.length && times[i + 1] - times[i] < 600 && ms >= times[i]) {
    const next = clip.samples[id][i + 1];
    if (Math.abs(next[0] - x) < 3 && Math.abs(next[1] - y) < 3) {   // otherwise it is a respawn jump
      const fraction = (ms - times[i]) / (times[i + 1] - times[i]);
      return [x + (next[0] - x) * fraction, y + (next[1] - y) * fraction];
    }
  }
  const seconds = Math.min(Math.max(ms - times[i], 0), 300) / 1000;
  return [x + vx * seconds, y + vy * seconds];
}

function playerIsDead(id, ms) {
  const changes = clip.deadChanges[id];
  if (!changes || !changes.length) return false;
  const i = lastIndexAtOrBefore(changes, ms, c => c[0]);
  return i >= 0 ? changes[i][1] : changes[0][1];
}

function eggStateAt(ms) {
  const list = clip.raw.egg;
  const i = lastIndexAtOrBefore(list, ms, c => c[0]);
  return i >= 0 ? { state: list[i][1], holder: list[i][2] } : { state: '', holder: null };
}

function eggFlightPosition(ms) {
  const list = clip.raw.bodies;
  const i = lastIndexAtOrBefore(list, ms, b => b[0]);
  if (i < 0) return null;
  const [t, x, y, vx, vy] = list[i];
  const seconds = Math.min(ms - t, 1500) / 1000;
  return [x + vx * seconds, y + vy * seconds];
}

function scoreAt(ms) {
  const list = clip.raw.scores;
  const i = lastIndexAtOrBefore(list, ms, s => s[0]);
  return i >= 0 ? { red: list[i][1], blue: list[i][2] } : { red: 0, blue: 0 };
}

// the endzone colours swap sides at halftime
function mapAt(ms) {
  const swap = clip.raw.swap;
  const swapped = swap !== null && ms >= swap;
  return clip.rows.map(row => swapped ? row.map(c => c === 'B' ? 'R' : c === 'R' ? 'B' : c) : row);
}

// ---------- drawing ----------

const TILE_COLOURS = { '#': '#333333', '.': '#e6e6e6', 'R': '#f4b6b6', 'B': '#b6c8f4' };
const GREEN = '#50ff78';
const GOLD = '#ffd400';

function sizeCanvas() {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round(mapCanvas.clientWidth * ratio), height = Math.round(mapCanvas.clientHeight * ratio);
  if (mapCanvas.width !== width || mapCanvas.height !== height) { mapCanvas.width = width; mapCanvas.height = height; }
}

function followedPosition() {
  if (viewSelect.value === 'player') return playerIsDead(clip.raw.focus, currentMs) ? null : playerPosition(clip.raw.focus, currentMs);
  if (viewSelect.value === 'egg') {
    const egg = eggStateAt(currentMs);
    if (egg.holder !== null && egg.holder !== undefined) return playerPosition(egg.holder, currentMs);
    return eggFlightPosition(currentMs);
  }
  return null;
}

function setCamera(worldWidth, worldHeight) {
  const fit = Math.min(mapCanvas.width / worldWidth, mapCanvas.height / worldHeight);
  const following = followedPosition();
  let scale = fit, centreX = worldWidth / 2, centreY = worldHeight / 2;
  if (following) {
    // the game's own watch camera: the window height shows 20 tiles, no stopping at the map edge, eased
    scale = mapCanvas.height / (GAME_VIEW_TILES_HIGH * TILE_UNITS * PIXELS_PER_UNIT) / 1.25;
    const targetX = following[0] * PIXELS_PER_UNIT + ENTITY_OFFSET, targetY = following[1] * PIXELS_PER_UNIT + ENTITY_OFFSET;
    smoothedCentre = smoothedCentre ? [smoothedCentre[0] + (targetX - smoothedCentre[0]) * 0.2, smoothedCentre[1] + (targetY - smoothedCentre[1]) * 0.2] : [targetX, targetY];
    centreX = smoothedCentre[0];
    centreY = smoothedCentre[1];
  } else {
    smoothedCentre = null;
  }
  view = { scale, offsetX: mapCanvas.width / 2 - centreX * scale, offsetY: mapCanvas.height / 2 - centreY * scale };
  drawing.setTransform(scale, 0, 0, scale, view.offsetX, view.offsetY);
}

function draw() {
  sizeCanvas();
  drawing.setTransform(1, 0, 0, 1, 0, 0);
  drawing.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
  if (!clip) return;
  const tilePixels = TILE_UNITS * PIXELS_PER_UNIT;
  const grid = mapAt(currentMs);
  setCamera(grid[0].length * tilePixels, grid.length * tilePixels);
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[y].length; x++) {
      drawing.fillStyle = TILE_COLOURS[grid[y][x]] || '#e6e6e6';
      drawing.fillRect(x * tilePixels, y * tilePixels, tilePixels, tilePixels);
    }
  }
  const field = fieldImageFor(clip.raw.art);
  if (imageReady(field)) {
    const innerWidth = (grid[0].length - 2) * tilePixels, innerHeight = (grid.length - 2) * tilePixels;
    drawing.drawImage(field, tilePixels, tilePixels, innerWidth, innerHeight);
    if (grid[1][1] === 'R') {   // after halftime: repaint each endzone from the other end of the texture
      const endWidth = field.naturalWidth * 3 / (grid[0].length - 2);
      const endPixels = 3 * tilePixels;
      drawing.drawImage(field, field.naturalWidth - endWidth, 0, endWidth, field.naturalHeight, tilePixels, tilePixels, endPixels, innerHeight);
      drawing.drawImage(field, 0, 0, endWidth, field.naturalHeight, tilePixels + innerWidth - endPixels, tilePixels, endPixels, innerHeight);
    }
  }
  drawing.translate(ENTITY_OFFSET, ENTITY_OFFSET);
  const egg = eggStateAt(currentMs);
  const focus = clip.raw.focus;
  const radius = PLAYER_RADIUS_UNITS * PIXELS_PER_UNIT;

  // markers: a line and a green ring for each teammate who was open, from 1.5 s before the moment to just after
  const moment = clip.raw.tag;
  if (currentMs >= moment - 1500 && currentMs <= moment + 400) {
    const from = playerPosition(focus, Math.min(currentMs, moment));
    for (const id of clip.raw.open) {
      const at = playerPosition(id, currentMs);
      if (!at || !from || playerIsDead(id, currentMs)) continue;
      drawing.strokeStyle = GREEN;
      drawing.lineWidth = 2 / view.scale * 1.5;
      drawing.beginPath();
      drawing.moveTo(from[0] * PIXELS_PER_UNIT, from[1] * PIXELS_PER_UNIT);
      drawing.lineTo(at[0] * PIXELS_PER_UNIT, at[1] * PIXELS_PER_UNIT);
      drawing.stroke();
      drawing.lineWidth = 3 / view.scale * 1.5;
      drawing.beginPath();
      drawing.arc(at[0] * PIXELS_PER_UNIT, at[1] * PIXELS_PER_UNIT, radius * 1.9, 0, Math.PI * 2);
      drawing.stroke();
    }
  }

  const ids = Object.keys(clip.samples);
  for (const id of ids) {
    if (playerIsDead(id, currentMs)) continue;
    const at = playerPosition(id, currentMs);
    if (!at) continue;
    const px = at[0] * PIXELS_PER_UNIT, py = at[1] * PIXELS_PER_UNIT;
    const ballImage = clip.team[id] === 'red' ? redBallImage : blueBallImage;
    if (imageReady(ballImage)) drawing.drawImage(ballImage, px - radius - 1, py - radius - 1, radius * 2 + 2, radius * 2 + 2);
    if (String(id) === String(focus)) {
      drawing.strokeStyle = GOLD;
      drawing.lineWidth = 3 / view.scale * 1.5;
      drawing.beginPath();
      drawing.arc(px, py, radius * 1.9, 0, Math.PI * 2);
      drawing.stroke();
    }
    if (egg.holder !== null && String(egg.holder) === String(id)) drawEgg(px, py);
    drawName(clip.name[id] || String(id), px, py);
  }
  if (egg.holder === null || egg.holder === undefined) {
    const at = eggFlightPosition(currentMs);
    if (at) drawEgg(at[0] * PIXELS_PER_UNIT, at[1] * PIXELS_PER_UNIT);
  }
  drawScoreboard();
}

// The game's name style: bold Arial, white, black outline and soft shadow, upper right of the ball.
function drawName(label, px, py) {
  const half = PIXELS_PER_UNIT / 100;
  const fontSize = Math.max(11 * half, 8 / view.scale);
  drawing.font = 'bold ' + fontSize + 'px Arial';
  drawing.textAlign = 'left';
  drawing.textBaseline = 'top';
  drawing.lineJoin = 'round';
  drawing.lineWidth = 2 * half * fontSize / (11 * half);
  drawing.strokeStyle = '#000000';
  drawing.fillStyle = '#ffffff';
  const x = px + 16 * half, y = py - 37 * half;
  drawing.save();
  drawing.shadowColor = 'rgba(0, 0, 0, 0.8)';
  drawing.shadowBlur = 3 * view.scale * fontSize / (11 * half);
  drawing.strokeText(label, x, y);
  drawing.restore();
  drawing.strokeText(label, x, y);
  drawing.fillText(label, x, y);
}

function drawEgg(px, py) {
  if (!imageReady(eggImage)) return;
  const scale = PIXELS_PER_UNIT / 100;   // the sprite is made for 100 pixels per unit
  const width = eggImage.naturalWidth * scale, height = eggImage.naturalHeight * scale;
  drawing.drawImage(eggImage, px - width / 2, py - height / 2, width, height);
}

function drawScoreboard() {
  const score = scoreAt(currentMs);
  const ratio = window.devicePixelRatio || 1;
  drawing.setTransform(ratio, 0, 0, ratio, 0, 0);
  const middle = mapCanvas.clientWidth / 2;
  drawing.lineJoin = 'round';
  drawing.lineWidth = 4;
  drawing.strokeStyle = '#000000';
  drawing.textBaseline = 'top';
  drawing.font = 'bold 34px Arial';
  drawing.globalAlpha = 0.9;
  for (const [align, text, x, colour] of [['right', String(score.red), middle - 30, '#ff3b3b'], ['left', String(score.blue), middle + 30, '#4d7cff']]) {
    drawing.textAlign = align;
    drawing.strokeText(text, x, 24);
    drawing.fillStyle = colour;
    drawing.fillText(text, x, 24);
  }
  drawing.globalAlpha = 1;
}

function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  return Math.floor(totalSeconds / 60) + ':' + String(totalSeconds % 60).padStart(2, '0');
}

// ---------- clips and the list ----------

const KIND_WORDS = {
  drop: ['tagged while holding the egg', 'tagged by'],
  interception: ['threw an interception', 'picked off by'],
};

function captionFor(raw, number, total) {
  const date = new Date(raw.at).toISOString().slice(0, 10);
  const who = id => (id !== null && id !== undefined && clip.name[id]) || '?';
  const open = raw.open.map(who).join(', ');
  const words = KIND_WORDS[raw.kind];
  return '#' + number + ' of ' + total + ' | ' + date + ' | game ' + raw.game.slice(0, 8) + ' | game clock ' + formatTime(raw.tag_ms) +
    ' | ' + who(raw.focus) + ' ' + words[0] + ' (' + words[1] + ' ' + who(raw.other) + ') | open teammates (green): ' + open;
}

function showClip(index) {
  if (!shownClips.length) return;
  clipIndex = (index + shownClips.length) % shownClips.length;
  const raw = shownClips[clipIndex];
  clip = prepareClip(raw);
  currentMs = 0;
  waitedMs = 0;
  smoothedCentre = null;
  lastFrameClock = null;
  captionDiv.textContent = captionFor(raw, clipIndex + 1, shownClips.length);
  for (const li of clipList.children) li.classList.toggle('current-clip', li.dataset.index === String(clipIndex));
  const current = clipList.querySelector('.current-clip');
  if (current) current.scrollIntoView({ block: 'nearest' });
  draw();
}

function clipLength() { return clip.raw.tag + 2000; }

function fillList() {
  clipList.innerHTML = '';
  shownClips.forEach((raw, index) => {
    const li = document.createElement('li');
    li.dataset.index = String(index);
    const date = new Date(raw.at).toISOString().slice(0, 10);
    const name = (raw.players.find(p => String(p[0]) === String(raw.focus)) || [0, '?'])[1];
    li.textContent = (index + 1) + '. ' + date + ' | ' + raw.kind + ' | ' + formatTime(raw.tag_ms) + ' | ' + raw.game.slice(0, 8);
    li.addEventListener('click', () => { playing = true; playPauseButton.textContent = 'Pause'; showClip(index); });
    clipList.appendChild(li);
  });
}

function applyKindFilter() {
  const kind = kindSelect.value;
  shownClips = data.clips.filter(c => kind === 'all' || c.kind === kind);
  fillList();
  showClip(0);
}

// ---------- playback ----------

function animate(clockMs) {
  if (clip) {
    if (lastFrameClock !== null && playing) {
      const passed = (clockMs - lastFrameClock) * parseFloat(speedSelect.value);
      if (currentMs < clipLength()) {
        currentMs = Math.min(clipLength(), currentMs + passed);
      } else if (playAllCheckbox.checked) {
        waitedMs += clockMs - lastFrameClock;
        if (waitedMs >= PAUSE_BETWEEN_CLIPS_MS) showClip(clipIndex + 1);
      }
    }
    lastFrameClock = clockMs;
    draw();
  }
  requestAnimationFrame(animate);
}

document.getElementById('previous-clip-button').addEventListener('click', () => showClip(clipIndex - 1));
document.getElementById('next-clip-button').addEventListener('click', () => showClip(clipIndex + 1));
document.getElementById('restart-clip-button').addEventListener('click', () => showClip(clipIndex));
playPauseButton.addEventListener('click', () => {
  playing = !playing;
  playPauseButton.textContent = playing ? 'Pause' : 'Play';
});
kindSelect.addEventListener('change', applyKindFilter);
document.addEventListener('keydown', event => {
  if (event.key === ' ') { event.preventDefault(); playPauseButton.click(); }
  if (event.key === 'ArrowRight') showClip(clipIndex + 1);
  if (event.key === 'ArrowLeft') showClip(clipIndex - 1);
});
window.addEventListener('resize', draw);

async function start() {
  data = await (await fetch('data.json')).json();
  document.title = data.title;
  document.getElementById('montage-title').textContent = data.title;
  document.getElementById('montage-explanation').textContent =
    'Newest first. Each clip is 5 seconds from a real playeggball.com ranked replay: 3 seconds before the moment and 2 after. ' +
    'Gold ring = the player. Green rings and lines = teammates with a straight, unblocked line to the player at that moment ' +
    '(no player of either team on the line). Space pauses, left and right arrows change clip.';
  const kinds = [...new Set(data.clips.map(c => c.kind))];
  kindSelect.innerHTML = '<option value="all">All (' + data.clips.length + ')</option>' +
    kinds.map(k => '<option value="' + k + '">' + (k === 'drop' ? 'Drops' : 'Interceptions') + ' (' + data.clips.filter(c => c.kind === k).length + ')</option>').join('');
  if (data.defaultKind && kinds.includes(data.defaultKind)) kindSelect.value = data.defaultKind;
  applyKindFilter();
  requestAnimationFrame(animate);
}
start();
