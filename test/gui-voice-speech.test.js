const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(repoRoot, 'cotw-scout-gui.html'), 'utf8');
const preload = fs.readFileSync(path.join(repoRoot, 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(repoRoot, 'main.js'), 'utf8');

test('Settings exposes Voice & Speech controls for local TTS', () => {
  assert.match(html, /Voice &amp; Speech/);
  assert.match(html, /id="voiceTtsMode"/);
  assert.match(html, /id="systemVoiceSelect"/);
  assert.match(html, /Preview/);
  assert.match(html, /Refresh voices/);
  assert.match(html, /Stop speaking/);
  assert.match(html, /function loadVoiceSettings\(/);
  assert.match(html, /function saveVoiceSettingsFromUI\(/);
  assert.match(html, /function previewSelectedVoice\(/);
});

test('renderer wires streaming chunks into the voice queue', () => {
  assert.match(html, /handleStreamingTtsDelta\(data\.delta\)/);
  assert.match(html, /flushStreamingTts\(data\?\.content\)/);
  assert.match(html, /function takeSpeakableChunk\(/);
  assert.match(html, /window\.cotw\.enqueueSpeechChunk/);
  assert.match(html, /stopSpeaking\(\);\s+if \(isElectron\)/);
});

test('chat input exposes a daily voice-mode toggle synced with voice settings', () => {
  assert.match(html, /id="voiceQuickToggle"/);
  assert.match(html, /onclick="toggleVoiceModeFromInput\(\)"/);
  assert.match(html, /function updateVoiceQuickToggleUI\(/);
  assert.match(html, /function toggleVoiceModeFromInput\(/);
  assert.match(html, /btn\.classList\.toggle\('active', active\)/);
  assert.match(html, /ttsMode: active \? 'off' : 'system'/);
  assert.match(html, /sttMode: active \? 'off' : 'pushToTalk'/);
  assert.match(html, /stopWhenOff: true/);
});

test('push-to-talk UI records locally and routes audio through STT IPC', () => {
  assert.match(html, /id="voiceSttMode"/);
  assert.match(html, /id="pttButton"/);
  assert.match(html, /onpointerdown="startPushToTalk\(event\)"/);
  assert.match(html, /function startPushToTalk\(/);
  assert.match(html, /navigator\.mediaDevices\.getUserMedia\(\{ audio: true \}\)/);
  assert.match(html, /new MediaRecorder/);
  assert.match(html, /window\.cotw\.transcribePttAudio/);
  assert.match(html, /window\.cotw\.startPttCapture/);
  assert.match(html, /window\.cotw\.stopPttCapture/);
  assert.match(html, /function useNativeSpeechHelper\(/);
  assert.match(html, /pttReleaseBehavior !== 'insertOnly'/);
});

test('preload exposes voice IPC methods', () => {
  assert.match(preload, /listSystemVoices: \(\) => ipcRenderer\.invoke\('voice:list-system-voices'\)/);
  assert.match(preload, /getVoiceSettings: \(\) => ipcRenderer\.invoke\('voice:get-settings'\)/);
  assert.match(preload, /saveVoiceSettings: \(settings\) => ipcRenderer\.invoke\('voice:save-settings', settings\)/);
  assert.match(preload, /previewSystemVoice: \(payload\) => ipcRenderer\.invoke\('voice:preview-system-voice', payload\)/);
  assert.match(preload, /enqueueSpeechChunk: \(payload\) => ipcRenderer\.invoke\('voice:enqueue-speech-chunk', payload\)/);
  assert.match(preload, /stopSpeaking: \(\) => ipcRenderer\.invoke\('voice:stop-speaking'\)/);
  assert.match(preload, /getSttStatus: \(\) => ipcRenderer\.invoke\('voice:stt-status'\)/);
  assert.match(preload, /startPttCapture: \(\) => ipcRenderer\.invoke\('voice:start-ptt'\)/);
  assert.match(preload, /stopPttCapture: \(\) => ipcRenderer\.invoke\('voice:stop-ptt'\)/);
  assert.match(preload, /cancelPttCapture: \(\) => ipcRenderer\.invoke\('voice:cancel-ptt'\)/);
  assert.match(preload, /transcribePttAudio: \(payload\) => ipcRenderer\.invoke\('voice:transcribe-ptt-audio', payload\)/);
});

test('main process validates local system voices and queues say playback safely', () => {
  assert.match(main, /function parseSystemVoices\(raw\)/);
  assert.match(main, /execFileSync\('\/usr\/bin\/say', \['-v', '\?'\]/);
  assert.match(main, /function validateInstalledVoiceId\(voiceId\)/);
  assert.match(main, /spawn\('\/usr\/bin\/say', \['-v', next\.voiceId, next\.text\]/);
  assert.match(main, /ipcMain\.handle\('voice:enqueue-speech-chunk'/);
  assert.match(main, /ipcMain\.handle\('voice:stop-speaking'/);
});

test('main process exposes native-first STT status and push-to-talk IPC', () => {
  assert.match(main, /function detectLocalSttBackend\(/);
  assert.match(main, /function speechHelperPath\(/);
  assert.match(main, /id: 'macos-speech-helper'/);
  assert.match(main, /resolveCommand\('whisper-cli'\)/);
  assert.match(main, /resolveCommand\('whisper'\)/);
  assert.match(main, /function startNativePttCapture\(/);
  assert.match(main, /function stopNativePttCapture\(/);
  assert.match(main, /function transcribePttAudio\(/);
  assert.match(main, /ipcMain\.handle\('voice:stt-status'/);
  assert.match(main, /ipcMain\.handle\('voice:start-ptt'/);
  assert.match(main, /ipcMain\.handle\('voice:stop-ptt'/);
  assert.match(main, /ipcMain\.handle\('voice:cancel-ptt'/);
  assert.match(main, /ipcMain\.handle\('voice:transcribe-ptt-audio'/);
});

test('OpenClaw config preservation keeps messages runtime state', () => {
  assert.match(main, /if \(existing\.messages\) \{\s+fresh\.messages = existing\.messages;\s+\}/);
});
