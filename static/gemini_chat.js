/**
 * Gemini AI Multimodal Hands-Free Voice, Vision, Mic VU Meter & Gesture Control System
 * Continuous Full-Duplex Voice Conversation Engine with Automatic Voice Activity Detection (VAD)
 * & Direct Gemini Audio Transcription Pipeline.
 */

const DEFAULT_GEMINI_KEY = atob('QVEuQWI4Uk42SU9GSDQ4UXNyWWNLLWEzUnp0OFc5RVZiZG0yTHJWRmlnQlE1Y0RySTBjaHc=');

class GeminiAIController {
    constructor(appOrchestrator) {
        this.app = appOrchestrator;
        this.apiKey = localStorage.getItem('GEMINI_API_KEY') || DEFAULT_GEMINI_KEY;
        this.micSensitivity = parseFloat(localStorage.getItem('MIC_SENSITIVITY')) || 100;
        this.isListening = false;
        this.aiSpeaking = false;
        this.gestureActive = true;
        
        this.audioContext = null;
        this.analyser = null;
        this.micStream = null;
        this.mediaRecorder = null;
        this.audioChunks = [];
        
        // Voice Activity Detection (VAD) state
        this.isRecordingAudio = false;
        this.silenceStart = 0;
        this.speechDetected = false;

        this.initDOM();
        this.initSpeechSynthesis();
        this.startGestureLoop();
        this.startCameraStream();

        this.autoStartMicAnalyser();
    }

    initDOM() {
        const btnSaveKey = document.getElementById('btnSaveApiKey');
        if (btnSaveKey) {
            btnSaveKey.addEventListener('click', () => {
                const key = document.getElementById('inputApiKey').value.trim();
                if (key) {
                    this.apiKey = key;
                    localStorage.setItem('GEMINI_API_KEY', key);
                    document.getElementById('apiKeyBox').style.display = 'none';
                    this.addMessage('System', 'Gemini API Key saved successfully!');
                }
            });
        }

        const btnKeySettings = document.getElementById('btnApiKeySettings');
        if (btnKeySettings) {
            btnKeySettings.addEventListener('click', () => {
                const box = document.getElementById('apiKeyBox');
                if (box) box.style.display = box.style.display === 'none' ? 'block' : 'none';
            });
        }

        const btnSend = document.getElementById('btnSendChat');
        if (btnSend) {
            btnSend.addEventListener('click', () => {
                const input = document.getElementById('chatInput');
                if (!input) return;
                const text = input.value.trim();
                if (text) {
                    input.value = '';
                    this.sendPromptToGemini(text);
                }
            });
        }

        const chatInput = document.getElementById('chatInput');
        if (chatInput) {
            chatInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    const text = e.target.value.trim();
                    if (text) {
                        e.target.value = '';
                        this.sendPromptToGemini(text);
                    }
                }
            });
        }

        const btnVision = document.getElementById('btnAskVision');
        if (btnVision) {
            btnVision.addEventListener('click', () => {
                this.sendPromptToGemini('Describe what you see in front of you through your camera!');
            });
        }

        const btnMic = document.getElementById('btnMic');
        if (btnMic) {
            btnMic.addEventListener('click', () => {
                if (this.isListening) {
                    this.stopListening();
                } else {
                    this.startListening();
                }
            });
        }

        const slideSens = document.getElementById('slideMicSensitivity');
        const valSens = document.getElementById('valMicSensitivity');
        if (slideSens) {
            slideSens.value = this.micSensitivity;
            if (valSens) valSens.textContent = `${Math.round(this.micSensitivity)}%`;
            slideSens.addEventListener('input', (e) => {
                this.micSensitivity = parseFloat(e.target.value);
                if (valSens) valSens.textContent = `${Math.round(this.micSensitivity)}%`;
                localStorage.setItem('MIC_SENSITIVITY', this.micSensitivity);
            });
        }
    }

    startCameraStream() {
        const img = document.getElementById('camFeed');
        if (!img) return;

        setInterval(() => {
            img.src = `/api/camera/frame?t=${Date.now()}`;
        }, 500);
    }

    autoStartMicAnalyser() {
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            this.startMicAudioAnalyser(false);
        }
    }

    startListening() {
        this.isListening = true;
        this.updateMicUI(true);
        this.startMicAudioAnalyser(true);
    }

    stopListening() {
        this.isListening = false;
        this.isRecordingAudio = false;
        this.updateMicUI(false);

        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            try { this.mediaRecorder.stop(); } catch (e) {}
        }
    }

    updateMicUI(active) {
        const btnMic = document.getElementById('btnMic');
        const statusText = document.getElementById('micStatusText');

        if (!btnMic) return;

        if (active) {
            btnMic.classList.add('active');
            btnMic.style.background = 'var(--accent-red)';
            btnMic.style.borderColor = 'var(--accent-red)';
            btnMic.style.boxShadow = '0 0 12px var(--accent-red)';
            btnMic.textContent = '🔴 Hands-Free ON';
            if (statusText) statusText.textContent = 'Status: Hands-free voice mode active. Speak anytime!';
        } else {
            btnMic.classList.remove('active');
            btnMic.style.background = 'linear-gradient(135deg, rgba(16,185,129,0.25), rgba(0,240,255,0.25))';
            btnMic.style.borderColor = 'var(--accent-green)';
            btnMic.style.boxShadow = '';
            btnMic.textContent = '🎙️ Hands-Free Voice';
            if (statusText) statusText.textContent = 'Status: Click to activate continuous hands-free voice mode.';
        }
    }

    startMicAudioAnalyser(userInitiated) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;

        navigator.mediaDevices.getUserMedia({ audio: true })
            .then(stream => {
                this.micStream = stream;
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
                
                if (this.audioContext.state === 'suspended' && userInitiated) {
                    this.audioContext.resume();
                }

                const source = this.audioContext.createMediaStreamSource(stream);
                this.analyser = this.audioContext.createAnalyser();
                this.analyser.fftSize = 256;
                source.connect(this.analyser);

                const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
                const vuBar = document.getElementById('micVuBar');
                const vuVal = document.getElementById('vuVal');
                const statusText = document.getElementById('micStatusText');

                if (statusText && !this.isListening) {
                    statusText.textContent = 'Status: Microphone active. Click Hands-Free Voice!';
                }

                const drawVU = () => {
                    if (!this.analyser) return;

                    this.analyser.getByteFrequencyData(dataArray);
                    let sum = 0;
                    for (let i = 0; i < dataArray.length; i++) {
                        sum += dataArray[i];
                    }
                    const average = sum / dataArray.length;
                    const gain = (this.micSensitivity || 100) / 100;
                    const volumePct = Math.min(100, Math.round((average / 128) * 100 * 2.8 * gain));

                    if (vuBar) {
                        vuBar.style.width = `${volumePct}%`;
                        if (volumePct > 15) {
                            vuBar.style.boxShadow = '0 0 16px var(--accent-red)';
                        } else {
                            vuBar.style.boxShadow = '0 0 8px var(--accent-green)';
                        }
                    }

                    if (vuVal) {
                        vuVal.textContent = `${volumePct}%`;
                        vuVal.style.color = volumePct > 20 ? 'var(--accent-red)' : 'var(--accent-green)';
                    }

                    // Voice Activity Detection (VAD) Logic
                    if (this.isListening && !this.aiSpeaking) {
                        if (volumePct > 12) {
                            // User is actively speaking
                            this.speechDetected = true;
                            this.silenceStart = 0;

                            if (!this.isRecordingAudio && this.micStream) {
                                this.startAudioChunkRecording();
                            }
                        } else if (this.isRecordingAudio && this.speechDetected) {
                            // User paused or stopped speaking
                            if (this.silenceStart === 0) {
                                this.silenceStart = performance.now();
                            } else if (performance.now() - this.silenceStart > 900) { // 900ms silence threshold
                                // Process recorded voice input
                                this.stopAudioChunkRecordingAndSend();
                            }
                        }
                    }

                    requestAnimationFrame(drawVU);
                };

                drawVU();
            })
            .catch(err => {
                console.error('Microphone access permission error:', err);
                const statusText = document.getElementById('micStatusText');
                if (statusText) statusText.textContent = 'Status: Please allow microphone permission in browser.';
            });
    }

    startAudioChunkRecording() {
        if (!this.micStream) return;
        try {
            const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';
            this.mediaRecorder = new MediaRecorder(this.micStream, { mimeType });
            this.audioChunks = [];

            this.mediaRecorder.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) {
                    this.audioChunks.push(e.data);
                }
            };

            this.mediaRecorder.start(100);
            this.isRecordingAudio = true;

            const statusText = document.getElementById('micStatusText');
            if (statusText) statusText.textContent = 'Status: 🎙️ VOICE DETECTED! Recording speech...';
        } catch (err) {
            console.warn('MediaRecorder start error:', err);
        }
    }

    stopAudioChunkRecordingAndSend() {
        if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') return;

        this.isRecordingAudio = false;
        this.speechDetected = false;
        this.silenceStart = 0;

        const statusText = document.getElementById('micStatusText');
        if (statusText) statusText.textContent = 'Status: ⏳ Transcribing voice with Gemini...';

        this.mediaRecorder.onstop = () => {
            if (this.audioChunks.length > 0) {
                const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';
                const blob = new Blob(this.audioChunks, { type: mimeType });
                this.sendVoiceBlobToGemini(blob, mimeType);
            }
        };

        try {
            this.mediaRecorder.stop();
        } catch (e) {}
    }

    sendVoiceBlobToGemini(audioBlob, mimeType) {
        const reader = new FileReader();
        reader.onloadend = () => {
            const base64Audio = reader.result.split(',')[1];
            
            fetch('/api/gemini/voice', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    audio_b64: base64Audio,
                    mime_type: mimeType,
                    api_key: this.apiKey,
                    include_vision: true
                })
            })
            .then(res => res.json())
            .then(data => {
                const transcribed = data.transcription || 'Spoken Voice Input';
                const reply = data.text || 'No response from Gemini Voice Engine.';

                // Live populate text box with exact transcribed words!
                const chatInput = document.getElementById('chatInput');
                if (chatInput) {
                    chatInput.value = transcribed;
                    chatInput.style.color = 'var(--accent-cyan)';
                }

                this.addMessage('User (Voice)', `🎤 "${transcribed}"`);
                this.addMessage('Gemini AI', reply);
                this.speak(reply);

                if (data.action) {
                    this.executeAIAction(data.action);
                }

                const statusText = document.getElementById('micStatusText');
                if (statusText && this.isListening) {
                    statusText.textContent = 'Status: Voice transcribed! Listening for next phrase...';
                }
            })
            .catch(err => {
                this.addMessage('Error', 'Failed to transcribe voice audio with Gemini.');
                console.error(err);
            });
        };
        reader.readAsDataURL(audioBlob);
    }

    initSpeechSynthesis() {
        this.synth = window.speechSynthesis;
        this.loadVoiceList();
        if (this.synth && this.synth.onvoiceschanged !== undefined) {
            this.synth.onvoiceschanged = () => this.loadVoiceList();
        }

        this.audioPlayer = new Audio();
        this.audioPlayer.crossOrigin = "anonymous";

        // Web Audio Analyser attached to Audio Player for exact sound-wave mouth synchronization
        let speakerAudioCtx = null;
        let speakerAnalyser = null;
        let speakerSource = null;

        const setupSpeakerAnalyser = () => {
            if (speakerAudioCtx) return;
            try {
                speakerAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
                speakerSource = speakerAudioCtx.createMediaElementSource(this.audioPlayer);
                speakerAnalyser = speakerAudioCtx.createAnalyser();
                speakerAnalyser.fftSize = 128;
                speakerSource.connect(speakerAnalyser);
                speakerAnalyser.connect(speakerAudioCtx.destination);
            } catch (e) {
                console.warn('Speaker audio analyser notice:', e);
            }
        };

        const speakerDataArray = new Uint8Array(64);
        let lastL298Audible = null;

        const monitorSpeakerOutput = () => {
            if (this.aiSpeaking && speakerAnalyser) {
                speakerAnalyser.getByteFrequencyData(speakerDataArray);
                let sum = 0;
                for (let i = 0; i < speakerDataArray.length; i++) {
                    sum += speakerDataArray[i];
                }
                const avgVolume = sum / speakerDataArray.length;

                // Flap mouth and pulse neck ONLY when audio is actively coming out of speakers
                const isAudible = avgVolume > 6;
                if (this.app.setMouthEnergized) this.app.setMouthEnergized(isAudible);
                if (this.app.setNeckPulsating) this.app.setNeckPulsating(isAudible);

                if (isAudible !== lastL298Audible) {
                    lastL298Audible = isAudible;
                    fetch('/api/motor/l298', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ mouth: isAudible, neck: isAudible })
                    }).catch(e => {});
                }
            } else if (!this.aiSpeaking) {
                if (this.app.setMouthEnergized) this.app.setMouthEnergized(false);
                if (this.app.setNeckPulsating) this.app.setNeckPulsating(false);
                if (lastL298Audible !== false) {
                    lastL298Audible = false;
                    fetch('/api/motor/l298', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ mouth: false, neck: false })
                    }).catch(e => {});
                }
            }
            requestAnimationFrame(monitorSpeakerOutput);
        };

        this.audioPlayer.onplay = () => {
            this.aiSpeaking = true;
            if (speakerAudioCtx && speakerAudioCtx.state === 'suspended') {
                speakerAudioCtx.resume();
            }
            setupSpeakerAnalyser();
        };

        this.audioPlayer.onpause = () => {
            this.aiSpeaking = false;
            if (this.app.setMouthEnergized) this.app.setMouthEnergized(false);
            if (this.app.setNeckPulsating) this.app.setNeckPulsating(false);
        };

        this.audioPlayer.onended = () => {
            this.aiSpeaking = false;
            if (this.app.setMouthEnergized) this.app.setMouthEnergized(false);
            if (this.app.setNeckPulsating) this.app.setNeckPulsating(false);

            fetch('/api/motor/l298', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mouth: false, neck: false })
            }).catch(e => {});
        };

        this.audioPlayer.onerror = () => {
            this.aiSpeaking = false;
            if (this.app.setMouthEnergized) this.app.setMouthEnergized(false);
            if (this.app.setNeckPulsating) this.app.setNeckPulsating(false);
        };

        monitorSpeakerOutput();
    }

    loadVoiceList() {
        const voiceSelect = document.getElementById('selectVoice');
        if (!voiceSelect) return;

        voiceSelect.innerHTML = '';

        // Preset AI Neural Voices (Male & Female)
        const aiVoices = [
            { id: 'ai_male_us', label: '♂️ AI Voice - Male (US Accent)' },
            { id: 'ai_male_uk', label: '♂️ AI Voice - Male (British Accent)' },
            { id: 'ai_male_au', label: '♂️ AI Voice - Male (Australian Accent)' },
            { id: 'ai_male_ie', label: '♂️ AI Voice - Male (Irish Accent)' },
            { id: 'ai_male_in', label: '♂️ AI Voice - Male (Indian English Accent)' },
            { id: 'ai_male_za', label: '♂️ AI Voice - Male (South African Accent)' },
            { id: 'ai_male_ca', label: '♂️ AI Voice - Male (Canadian Accent)' },
            { id: 'ai_female_us', label: '♀️ AI Voice - Female (US Accent)' },
            { id: 'ai_female_uk', label: '♀️ AI Voice - Female (British Accent)' },
            { id: 'ai_female_au', label: '♀️ AI Voice - Female (Australian Accent)' },
            { id: 'ai_female_ca', label: '♀️ AI Voice - Female (Canadian Accent)' },
            { id: 'ai_female_in', label: '♀️ AI Voice - Female (Indian English Accent)' }
        ];

        aiVoices.forEach((v, idx) => {
            const opt = document.createElement('option');
            opt.value = v.id;
            opt.textContent = v.label;
            if (idx === 0) opt.selected = true;
            voiceSelect.appendChild(opt);
        });

        // Add System Browser Voices if available
        if (this.synth) {
            const voices = this.synth.getVoices();
            if (voices.length > 0) {
                const groupOpt = document.createElement('option');
                groupOpt.disabled = true;
                groupOpt.textContent = '─── System Browser Voices ───';
                voiceSelect.appendChild(groupOpt);

                voices.forEach((v, idx) => {
                    const opt = document.createElement('option');
                    opt.value = `sys_${idx}`;
                    
                    let genderIcon = '🗣️';
                    const lowerName = v.name.toLowerCase();
                    if (lowerName.includes('female') || lowerName.includes('samantha') || lowerName.includes('karen') || lowerName.includes('zira') || lowerName.includes('victoria') || lowerName.includes('fiona')) {
                        genderIcon = '♀️';
                    } else if (lowerName.includes('male') || lowerName.includes('alex') || lowerName.includes('daniel') || lowerName.includes('david') || lowerName.includes('fred') || lowerName.includes('george')) {
                        genderIcon = '♂️';
                    }

                    opt.textContent = `${genderIcon} ${v.name} (${v.lang})`;
                    voiceSelect.appendChild(opt);
                });
            }
        }
    }

    speak(text) {
        if (!text) return;

        const cleanText = text.replace(/\*[^*]*\*/g, '').trim();
        if (!cleanText) return;

        const voiceSelect = document.getElementById('selectVoice');
        const selectedVoiceVal = voiceSelect ? voiceSelect.value : 'ai_female_us';

        // 1. If a system browser voice is selected
        if (selectedVoiceVal.startsWith('sys_') && this.synth) {
            const sysIndex = parseInt(selectedVoiceVal.replace('sys_', ''), 10);
            const voices = this.synth.getVoices();
            const selectedVoice = voices[sysIndex];

            if (selectedVoice) {
                this.synth.cancel();
                if (this.synth.paused) this.synth.resume();

                const utterance = new SpeechSynthesisUtterance(cleanText);
                utterance.voice = selectedVoice;
                utterance.rate = 1.0;
                utterance.pitch = 1.0;

                utterance.onstart = () => {
                    this.aiSpeaking = true;
                    if (this.app.setMouthEnergized) this.app.setMouthEnergized(true);
                    if (this.app.setNeckPulsating) this.app.setNeckPulsating(true);
                };

                utterance.onend = () => {
                    this.aiSpeaking = false;
                    if (this.app.setMouthEnergized) this.app.setMouthEnergized(false);
                    if (this.app.setNeckPulsating) this.app.setNeckPulsating(false);
                };

                this.synth.speak(utterance);
                return;
            }
        }

        // 2. Preset AI Neural Voices (Male & Female Accents) via Server
        const encodedText = encodeURIComponent(cleanText);
        const encodedVoice = encodeURIComponent(selectedVoiceVal);
        this.audioPlayer.src = `/api/tts/speak?text=${encodedText}&voice=${encodedVoice}`;
        this.audioPlayer.play().catch(err => {
            if (this.synth) {
                this.synth.cancel();
                if (this.synth.paused) this.synth.resume();
                const utterance = new SpeechSynthesisUtterance(cleanText);
                utterance.onstart = () => this.audioPlayer.onplay();
                utterance.onend = () => this.audioPlayer.onended();
                this.synth.speak(utterance);
            }
        });
    }

    addMessage(sender, text) {
        const history = document.getElementById('chatHistory');
        if (!history) return;

        const msgDiv = document.createElement('div');
        msgDiv.className = `msg ${sender.toLowerCase()}`;
        msgDiv.innerHTML = `<strong>${sender}:</strong> ${text}`;
        history.appendChild(msgDiv);
        history.scrollTop = history.scrollHeight;
    }

    sendPromptToGemini(promptText) {
        this.addMessage('User', promptText);

        fetch('/api/gemini/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt: promptText,
                api_key: this.apiKey,
                include_vision: true
            })
        })
        .then(res => res.json())
        .then(data => {
            const reply = data.text || 'No response from Gemini.';
            this.addMessage('Gemini AI', reply);
            this.speak(reply);

            if (data.action) {
                this.executeAIAction(data.action);
            }
        })
        .catch(err => {
            this.addMessage('Error', 'Failed to reach Gemini AI backend.');
            console.error(err);
        });
    }

    startGestureLoop() {
        setInterval(() => {
            if (!this.gestureActive) return;

            fetch('/api/gemini/gesture', { method: 'POST' })
            .then(res => res.json())
            .then(data => {
                const badge = document.getElementById('gestureBadge');
                if (!badge) return;

                if (data.gesture === '5_FINGERS_FORWARD') {
                    badge.textContent = '🖐️ 5 Fingers: Wave Arm Dance!';
                    badge.style.color = 'var(--accent-green)';
                    if (this.app.applyPresetPose) this.app.applyPresetPose('Wave Arm Dance');
                } else if (data.gesture === '2_FINGERS_WAVE') {
                    badge.textContent = '✌️ 2 Fingers: Grab & Hold';
                    badge.style.color = 'var(--accent-blue)';
                    if (this.app.applyPresetPose) this.app.applyPresetPose('Grab & Hold');
                } else if (data.gesture === '1_FINGER_ATTACK') {
                    badge.textContent = '☝️ 1 Finger: Home Stance';
                    badge.style.color = 'var(--accent-orange)';
                    if (this.app.applyPresetPose) this.app.applyPresetPose('Home / Rest');
                } else {
                    badge.textContent = 'Gesture: Monitoring Camera...';
                    badge.style.color = 'var(--accent-cyan)';
                }

                if (data.action) {
                    this.executeAIAction(data.action);
                }
            })
            .catch(err => console.error('Gesture detection error:', err));
        }, 800);
    }

    executeAIAction(action) {
        if (!action || !action.name) return;

        console.log("Executing AI Action:", action);

        if (action.name === 'arm_move') {
            const args = action.args || {};
            if (this.app.setJointAngles) {
                this.app.setJointAngles(args);
            }
        } else if (action.name === 'arm_pose' || action.name === 'hexapod_pose') {
            const pose = (action.args && action.args.pose_name) ? action.args.pose_name : 'Home / Rest';
            if (this.app.applyPresetPose) {
                this.app.applyPresetPose(pose);
            }
        } else if (action.name === 'arm_stop' || action.name === 'hexapod_stop') {
            if (this.app.applyPresetPose) {
                this.app.applyPresetPose('Home / Rest');
            }
        } else if (action.name === 'hexapod_walk') {
            const dir = (action.args && action.args.direction) ? action.args.direction : 'forward';
            if (dir === 'forward') {
                if (this.app.applyPresetPose) this.app.applyPresetPose('Pick / Reach Floor');
            } else if (dir === 'backward') {
                if (this.app.applyPresetPose) this.app.applyPresetPose('Park Position');
            } else if (dir === 'turn_left' || dir === 'left') {
                if (this.app.setJointAngles) this.app.setJointAngles({ j1_base: -45 });
            } else if (dir === 'turn_right' || dir === 'right') {
                if (this.app.setJointAngles) this.app.setJointAngles({ j1_base: 45 });
            }
        }
    }
}
