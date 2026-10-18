/**
 * Main 6-DOF Robot Arm App Orchestrator
 * Connects UI inputs, Top Tab Navigation, Servo Calibration (6 Servos),
 * 6-DOF Arm Kinematics solver, 3D WebGL Renderer, and Gemini AI Agent.
 */

document.addEventListener('DOMContentLoaded', () => {
    // Instantiate Core Engines
    const kinematics = new ArmKinematics();
    const renderer = new Hexapod3DRenderer('viewport3d');

    let activePose = 'Home / Rest';
    const activeKeys = {};
    let lastTime = performance.now();

    // DOM Elements - Sliders for 6-DOF Arm
    const slideJ1 = document.getElementById('slideJ1');
    const slideJ2 = document.getElementById('slideJ2');
    const slideJ3 = document.getElementById('slideJ3');
    const slideJ4 = document.getElementById('slideJ4');
    const slideJ5 = document.getElementById('slideJ5');
    const slideJ6 = document.getElementById('slideJ6');

    const valJ1 = document.getElementById('valJ1');
    const valJ2 = document.getElementById('valJ2');
    const valJ3 = document.getElementById('valJ3');
    const valJ4 = document.getElementById('valJ4');
    const valJ5 = document.getElementById('valJ5');
    const valJ6 = document.getElementById('valJ6');

    const eeX = document.getElementById('eeX');
    const eeY = document.getElementById('eeY');
    const eeZ = document.getElementById('eeZ');

    const ikStatusSpan  = document.getElementById('ikStatus');
    const telemetryGrid = document.getElementById('telemetryGrid');

    // Build 6 Servo Joint Telemetry & Calibration Panels
    initTelemetryGrid();
    initCalibrationGrid();

    // Setup Navigation Tabs & Event Listeners
    setupTopNavTabs();
    setupSliderListeners();
    setupPresetButtons();
    setupDPadControls();
    setupKeyboardListeners();
    setupMp3MusicPlayer();

    // Application API exposed to Gemini AI controller
    const appAPI = {
        applyPresetPose: (poseName) => {
            applyPresetPose(poseName);
        },
        setJointAngles: (angles) => {
            if (angles.j1_base !== undefined && slideJ1) slideJ1.value = angles.j1_base;
            if (angles.j2_shoulder !== undefined && slideJ2) slideJ2.value = angles.j2_shoulder;
            if (angles.j3_elbow !== undefined && slideJ3) slideJ3.value = angles.j3_elbow;
            if (angles.j4_wrist !== undefined && slideJ4) slideJ4.value = angles.j4_wrist;
            if (angles.j5_wrist_roll !== undefined && slideJ5) slideJ5.value = angles.j5_wrist_roll;
            if (angles.j6_gripper !== undefined && slideJ6) slideJ6.value = angles.j6_gripper;
            else if (angles.j5_gripper !== undefined && slideJ6) slideJ6.value = angles.j5_gripper;
            updateJointsFromSliders();
        },
        setMouthEnergized: (energized) => {
            renderer.mouthEnergized = energized;
            const el = document.getElementById('motorMouthStatus');
            if (el) {
                el.textContent = energized ? 'ENERGIZED (TALKING)' : 'OFF';
                el.style.color = energized ? 'var(--accent-green)' : 'var(--text-muted)';
            }
        },
        setNeckPulsating: (pulsating) => {
            renderer.neckPulsating = pulsating;
            const el = document.getElementById('motorNeckStatus');
            if (el) {
                el.textContent = pulsating ? 'ENERGIZED (PULSING)' : 'OFF';
                el.style.color = pulsating ? 'var(--accent-purple)' : 'var(--text-muted)';
            }
        }
    };

    const geminiController = new GeminiAIController(appAPI);

    // Poll HC-SR04 Distance Sensor
    setInterval(() => {
        fetch('/api/sensors/distances')
            .then(res => res.json())
            .then(data => {
                renderer.sensorDistances = data;
                const elF = document.getElementById('distFront');
                if (elF) elF.textContent = `${data.front} cm`;
            })
            .catch(err => {});
    }, 400);

    // Camera Source Selector
    const selectCamera = document.getElementById('selectCamera');
    const btnSwitchCamera = document.getElementById('btnSwitchCamera');
    const btnDefaultEmeetPixy = document.getElementById('btnDefaultEmeetPixy');

    const changeCameraSource = (sourceVal) => {
        const source = sourceVal || (selectCamera ? selectCamera.value : 'usb');
        if (selectCamera && sourceVal) selectCamera.value = source;

        fetch('/api/camera/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source })
        })
        .then(res => res.json())
        .then(data => {
            const camFeed = document.getElementById('camFeed');
            if (camFeed) camFeed.src = `/api/camera/frame?t=${Date.now()}`;
        })
        .catch(err => {});
    };

    if (selectCamera) selectCamera.addEventListener('change', (e) => changeCameraSource(e.target.value));
    if (btnSwitchCamera) btnSwitchCamera.addEventListener('click', () => changeCameraSource());
    if (btnDefaultEmeetPixy) btnDefaultEmeetPixy.addEventListener('click', () => changeCameraSource('usb'));

    // Export Python Button
    document.getElementById('btnExportScript').addEventListener('click', exportPythonCode);
    document.getElementById('btnResetCam').addEventListener('click', () => {
        renderer.camera.position.set(380, 280, 420);
        renderer.controls.target.set(0, 110, 0);
    });

    document.getElementById('btnResetJoints').addEventListener('click', () => {
        slideJ1.value = 0;
        slideJ2.value = 30;
        slideJ3.value = 45;
        slideJ4.value = 0;
        if (slideJ5) slideJ5.value = 0;
        if (slideJ6) slideJ6.value = 50;
        updateJointsFromSliders();
    });

    // Start Render Animation Loop
    requestAnimationFrame(animate);

    function animate(now) {
        requestAnimationFrame(animate);

        const dt = Math.min((now - lastTime) / 1000, 0.1);
        lastTime = now;

        updateJointsFromKeyboard();

        kinematics.activePose = activePose;
        const currentAngles = kinematics.updateMotionRoutine(dt, now);

        const fk = kinematics.computeForwardKinematics(currentAngles);

        if (eeX) eeX.textContent = `${Math.round(fk.endEffector.x)} mm`;
        if (eeY) eeY.textContent = `${Math.round(fk.endEffector.y)} mm`;
        if (eeZ) eeZ.textContent = `${Math.round(fk.endEffector.z)} mm`;

        renderer.updatePose(null, { jointAngles: currentAngles, fk: fk });
        renderer.render();

        updateTelemetryUI(currentAngles);
    }

    function setupTopNavTabs() {
        const tabBtns = document.querySelectorAll('.nav-tab-btn');
        const screens = document.querySelectorAll('.view-screen');

        const moveCanvasToView = (viewName) => {
            const dom = renderer.renderer.domElement;
            if (viewName === 'viewCalibration') {
                const calibContainer = document.getElementById('calibViewport3d');
                if (calibContainer && dom.parentElement !== calibContainer) {
                    calibContainer.appendChild(dom);
                }
            } else if (viewName === 'viewAnimation') {
                const animContainer = document.getElementById('viewport3d');
                if (animContainer && dom.parentElement !== animContainer) {
                    animContainer.appendChild(dom);
                }
            }
            renderer.onWindowResize();
            setTimeout(() => renderer.onWindowResize(), 50);
            setTimeout(() => renderer.onWindowResize(), 200);
        };

        tabBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                tabBtns.forEach(b => b.classList.remove('active'));
                screens.forEach(s => {
                    s.classList.remove('active');
                    s.style.display = 'none';
                });

                btn.classList.add('active');
                const targetViewId = btn.dataset.view || btn.getAttribute('data-view');
                const targetView = document.getElementById(targetViewId);
                if (targetView) {
                    targetView.classList.add('active');
                    if (targetViewId === 'viewWiring' || targetViewId === 'viewInstructions') {
                        targetView.style.display = 'block';
                    } else {
                        targetView.style.display = 'grid';
                    }
                }

                try {
                    moveCanvasToView(targetViewId);
                } catch (err) {
                    console.error("Error moving canvas to view:", err);
                }
            });
        });

        // PDF Export & Print Button Handlers
        const setupPdfHandler = (btnId, elementSelector, filename) => {
            const btn = document.getElementById(btnId);
            if (!btn) return;
            btn.addEventListener('click', async () => {
                const element = document.querySelector(elementSelector);
                if (!element) return;

                const origText = btn.innerHTML;
                btn.innerHTML = '⏳ Exporting PDF...';
                btn.disabled = true;

                document.body.classList.add('exporting-pdf');

                const opt = {
                    margin: [8, 8, 8, 8],
                    filename: filename,
                    image: { type: 'jpeg', quality: 0.98 },
                    html2canvas: {
                        scale: 2,
                        useCORS: true,
                        logging: false,
                        backgroundColor: '#0f172a'
                    },
                    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
                    pagebreak: { mode: ['avoid-all', 'css', 'legacy'] }
                };

                try {
                    if (window.html2pdf) {
                        await html2pdf().set(opt).from(element).save();
                    } else {
                        window.print();
                    }
                } catch (err) {
                    console.error("PDF generation error, falling back to print:", err);
                    window.print();
                } finally {
                    document.body.classList.remove('exporting-pdf');
                    btn.innerHTML = origText;
                    btn.disabled = false;
                }
            });
        };

        setupPdfHandler('btnExportWiringPDF', '#viewWiring .wiring-container', '6-DOF_Robotic_Arm_Wiring_Schematic.pdf');
        setupPdfHandler('btnExportInstructionsPDF', '#viewInstructions .guide-wrapper', '6-DOF_Robotic_Arm_Operating_Instructions.pdf');

        const btnPrintWiringPDF = document.getElementById('btnPrintWiringPDF');
        if (btnPrintWiringPDF) {
            btnPrintWiringPDF.addEventListener('click', () => window.print());
        }

        const btnPrintInstructionsPDF = document.getElementById('btnPrintInstructionsPDF');
        if (btnPrintInstructionsPDF) {
            btnPrintInstructionsPDF.addEventListener('click', () => window.print());
        }

        const btnExportWiringScript = document.getElementById('btnExportWiringScript');
        if (btnExportWiringScript) {
            const btnExportScript = document.getElementById('btnExportScript');
            if (btnExportScript) {
                btnExportWiringScript.addEventListener('click', () => btnExportScript.click());
            }
        }

        const btnResetCamCalib = document.getElementById('btnResetCamCalib');
        if (btnResetCamCalib) {
            btnResetCamCalib.addEventListener('click', () => {
                renderer.camera.position.set(380, 280, 420);
                renderer.controls.target.set(0, 110, 0);
            });
        }
    }

    function initTelemetryGrid() {
        const jointNames = [
            { id: 'j1_base', label: 'J1: Base Yaw' },
            { id: 'j2_shoulder', label: 'J2: Shoulder Pitch' },
            { id: 'j3_elbow', label: 'J3: Elbow Pitch' },
            { id: 'j4_wrist', label: 'J4: Wrist Pitch' },
            { id: 'j5_wrist_roll', label: 'J5: Wrist Roll' },
            { id: 'j6_gripper', label: 'J6: Gripper Claw' }
        ];

        telemetryGrid.innerHTML = '';
        jointNames.forEach(j => {
            const card = document.createElement('div');
            card.className = 'leg-card';
            card.innerHTML = `
                <div class="leg-title">${j.label}</div>
                <div class="joint-row"><span>Angle:</span><span class="joint-deg" id="deg_${j.id}">0°</span></div>
            `;
            telemetryGrid.appendChild(card);
        });
    }

    function initCalibrationGrid() {
        const calibGrid = document.getElementById('calibrationGrid');
        if (!calibGrid) return;

        const joints = [
            { id: 'j1_base', label: 'J1: Base Rotation Servo' },
            { id: 'j2_shoulder', label: 'J2: Shoulder Servo' },
            { id: 'j3_elbow', label: 'J3: Elbow Servo' },
            { id: 'j4_wrist', label: 'J4: Wrist Pitch Servo' },
            { id: 'j5_wrist_roll', label: 'J5: Wrist Roll Servo' },
            { id: 'j6_gripper', label: 'J6: Gripper Servo' }
        ];

        calibGrid.innerHTML = '';

        const generateOffsetOptions = (selectedVal = 0) => {
            let opts = '';
            for (let deg = -30; deg <= 30; deg++) {
                const label = deg > 0 ? `+${deg}°` : `${deg}°`;
                const sel = (deg === selectedVal) ? 'selected' : '';
                opts += `<option value="${deg}" ${sel}>${label}</option>`;
            }
            return opts;
        };

        joints.forEach(j => {
            const card = document.createElement('div');
            card.className = 'calib-leg-card';
            card.innerHTML = `
                <div class="leg-title" style="font-size:0.85rem; margin-bottom:10px;">${j.label}</div>
                
                <div class="slider-control">
                    <div class="slider-label">
                        <span>Trim Angle Offset</span>
                        <div style="display:flex; align-items:center; gap:6px;">
                            <select class="trim-dropdown" data-joint="${j.id}" id="selectTrim_${j.id}">
                                ${generateOffsetOptions(0)}
                            </select>
                            <span class="slider-val" id="valTrim_${j.id}">0°</span>
                        </div>
                    </div>
                    <input type="range" class="trim-slider" data-joint="${j.id}" id="slideTrim_${j.id}" min="-30" max="30" value="0">
                </div>
            `;
            calibGrid.appendChild(card);
        });

        const updateServoOffset = (jointId, val) => {
            kinematics.calibrationTrims[jointId] = val;

            const slider = document.getElementById(`slideTrim_${jointId}`);
            const dropdown = document.getElementById(`selectTrim_${jointId}`);
            const valDisplay = document.getElementById(`valTrim_${jointId}`);

            if (slider && parseInt(slider.value, 10) !== val) slider.value = val;
            if (dropdown && parseInt(dropdown.value, 10) !== val) dropdown.value = val;
            if (valDisplay) valDisplay.textContent = (val > 0 ? `+${val}°` : `${val}°`);
        };

        document.querySelectorAll('.trim-dropdown').forEach(select => {
            select.addEventListener('change', (e) => {
                updateServoOffset(e.target.dataset.joint, parseInt(e.target.value, 10));
            });
        });

        document.querySelectorAll('.trim-slider').forEach(slider => {
            slider.addEventListener('input', (e) => {
                updateServoOffset(e.target.dataset.joint, parseInt(e.target.value, 10));
            });
        });

        const btnResetCalib = document.getElementById('btnResetCalibration');
        if (btnResetCalib) {
            btnResetCalib.addEventListener('click', () => {
                ['j1_base', 'j2_shoulder', 'j3_elbow', 'j4_wrist', 'j5_wrist_roll', 'j6_gripper'].forEach(j => {
                    updateServoOffset(j, 0);
                });
            });
        }
    }

    function updateTelemetryUI(angles) {
        ['j1_base', 'j2_shoulder', 'j3_elbow', 'j4_wrist', 'j5_wrist_roll'].forEach(j => {
            const el = document.getElementById(`deg_${j}`);
            if (el) el.textContent = `${Math.round(angles[j] || 0)}°`;
        });
        const elGrip = document.getElementById('deg_j6_gripper');
        if (elGrip) elGrip.textContent = `${Math.round(angles.j6_gripper !== undefined ? angles.j6_gripper : angles.j5_gripper || 50)}%`;
    }

    function setupSliderListeners() {
        const update = () => updateJointsFromSliders();

        slideJ1.addEventListener('input', update);
        slideJ2.addEventListener('input', update);
        slideJ3.addEventListener('input', update);
        slideJ4.addEventListener('input', update);
        if (slideJ5) slideJ5.addEventListener('input', update);
        if (slideJ6) slideJ6.addEventListener('input', update);
    }

    function updateJointsFromSliders() {
        kinematics.jointAngles.j1_base      = parseInt(slideJ1.value, 10);
        kinematics.jointAngles.j2_shoulder  = parseInt(slideJ2.value, 10);
        kinematics.jointAngles.j3_elbow     = parseInt(slideJ3.value, 10);
        kinematics.jointAngles.j4_wrist     = parseInt(slideJ4.value, 10);
        if (slideJ5) kinematics.jointAngles.j5_wrist_roll = parseInt(slideJ5.value, 10);
        if (slideJ6) kinematics.jointAngles.j6_gripper    = parseInt(slideJ6.value, 10);

        valJ1.textContent = `${kinematics.jointAngles.j1_base}°`;
        valJ2.textContent = `${kinematics.jointAngles.j2_shoulder}°`;
        valJ3.textContent = `${kinematics.jointAngles.j3_elbow}°`;
        valJ4.textContent = `${kinematics.jointAngles.j4_wrist}°`;
        if (valJ5) valJ5.textContent = `${kinematics.jointAngles.j5_wrist_roll}°`;
        if (valJ6) valJ6.textContent = `${kinematics.jointAngles.j6_gripper}%`;

        // Send to backend
        fetch('/api/arm/joints', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(kinematics.jointAngles)
        }).catch(err => {});
    }

    function setupPresetButtons() {
        const buttons = document.querySelectorAll('#presetButtons button');
        buttons.forEach(btn => {
            btn.addEventListener('click', () => {
                applyPresetPose(btn.dataset.pose);
            });
        });
    }

    function applyPresetPose(poseName) {
        activePose = poseName;
        switch (poseName) {
            case "Home / Rest":
                slideJ1.value = 0; slideJ2.value = 0; slideJ3.value = 0; slideJ4.value = 0; if (slideJ5) slideJ5.value = 0; if (slideJ6) slideJ6.value = 0;
                break;
            case "Pick / Reach Floor":
                slideJ1.value = 0; slideJ2.value = 45; slideJ3.value = -60; slideJ4.value = -30; if (slideJ5) slideJ5.value = 0; if (slideJ6) slideJ6.value = 80;
                break;
            case "Place / Elevated Target":
                slideJ1.value = 45; slideJ2.value = 30; slideJ3.value = -20; slideJ4.value = 10; if (slideJ5) slideJ5.value = 30; if (slideJ6) slideJ6.value = 10;
                break;
            case "Reach High":
                slideJ1.value = 0; slideJ2.value = 80; slideJ3.value = 45; slideJ4.value = 30; if (slideJ5) slideJ5.value = 0; if (slideJ6) slideJ6.value = 0;
                break;
            case "Wave Arm Dance":
                slideJ1.value = 30; slideJ2.value = 45; slideJ3.value = 30; slideJ4.value = 45; if (slideJ5) slideJ5.value = 45; if (slideJ6) slideJ6.value = 80;
                break;
            case "Orchestra Conductor":
            case "Music Conductor":
            case "Maestro Conductor":
                slideJ1.value = 0; slideJ2.value = 40; slideJ3.value = 30; slideJ4.value = 20; if (slideJ5) slideJ5.value = 30; if (slideJ6) slideJ6.value = 50;
                break;
            case "Symphony Maestro Sweep":
                slideJ1.value = -30; slideJ2.value = 50; slideJ3.value = 20; slideJ4.value = 35; if (slideJ5) slideJ5.value = -30; if (slideJ6) slideJ6.value = 80;
                break;
            case "Rock Concert Conductor":
                slideJ1.value = 15; slideJ2.value = 60; slideJ3.value = -20; slideJ4.value = 45; if (slideJ5) slideJ5.value = 60; if (slideJ6) slideJ6.value = 100;
                break;
            case "Grab & Hold":
                slideJ1.value = 0; slideJ2.value = 30; slideJ3.value = -40; slideJ4.value = -20; if (slideJ5) slideJ5.value = 0; if (slideJ6) slideJ6.value = 100;
                break;
            case "Salute / Respect":
                slideJ1.value = -45; slideJ2.value = 60; slideJ3.value = 60; slideJ4.value = 0; if (slideJ5) slideJ5.value = -45; if (slideJ6) slideJ6.value = 0;
                break;
            case "Arm Disco Dance":
                slideJ1.value = 60; slideJ2.value = 50; slideJ3.value = -30; slideJ4.value = 40; if (slideJ5) slideJ5.value = 60; if (slideJ6) slideJ6.value = 50;
                break;
            case "Park Position":
                slideJ1.value = 0; slideJ2.value = -80; slideJ3.value = -90; slideJ4.value = -40; if (slideJ5) slideJ5.value = 0; if (slideJ6) slideJ6.value = 0;
                break;
            case "Scan Environment":
                slideJ1.value = 90; slideJ2.value = 20; slideJ3.value = 0; slideJ4.value = 0; if (slideJ5) slideJ5.value = 45; if (slideJ6) slideJ6.value = 20;
                break;
            case "Gesture Yes":
            case "Yes":
                slideJ1.value = 0; slideJ2.value = 40; slideJ3.value = 20; slideJ4.value = 30; if (slideJ5) slideJ5.value = 0; if (slideJ6) slideJ6.value = 50;
                break;
            case "Gesture No":
            case "No":
                slideJ1.value = 0; slideJ2.value = 30; slideJ3.value = 30; slideJ4.value = 0; if (slideJ5) slideJ5.value = 0; if (slideJ6) slideJ6.value = 50;
                break;
            case "High Five":
            case "Hi Five":
                slideJ1.value = 0; slideJ2.value = 65; slideJ3.value = 20; slideJ4.value = 45; if (slideJ5) slideJ5.value = 0; if (slideJ6) slideJ6.value = 100;
                break;
        }
        updateJointsFromSliders();
    }

    function setupDPadControls() {
        const bindButton = (id, deltaJ1, deltaJ2, deltaJ6) => {
            const btn = document.getElementById(id);
            if (!btn) return;

            btn.addEventListener('click', () => {
                slideJ1.value = parseInt(slideJ1.value, 10) + deltaJ1;
                slideJ2.value = parseInt(slideJ2.value, 10) + deltaJ2;
                if (slideJ6) slideJ6.value = Math.max(0, Math.min(100, parseInt(slideJ6.value, 10) + deltaJ6));
                updateJointsFromSliders();
            });
        };

        bindButton('btnShoulderUp', 0, 10, 0);
        bindButton('btnShoulderDown', 0, -10, 0);
        bindButton('btnBaseLeft', -15, 0, 0);
        bindButton('btnBaseRight', 15, 0, 0);
        bindButton('btnClawOpen', 0, 0, 25);
        bindButton('btnClawClose', 0, 0, -25);

        document.getElementById('btnStop').addEventListener('click', () => {
            applyPresetPose('Home / Rest');
        });
    }

    function setupKeyboardListeners() {
        window.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT') return;
            activeKeys[e.key.toLowerCase()] = true;
        });

        window.addEventListener('keyup', (e) => {
            activeKeys[e.key.toLowerCase()] = false;
        });
    }

    function updateJointsFromKeyboard() {
        let changed = false;
        if (activeKeys['a'] || activeKeys['arrowleft']) { slideJ1.value = parseInt(slideJ1.value, 10) - 2; changed = true; }
        if (activeKeys['d'] || activeKeys['arrowright']) { slideJ1.value = parseInt(slideJ1.value, 10) + 2; changed = true; }
        if (activeKeys['w'] || activeKeys['arrowup']) { slideJ2.value = parseInt(slideJ2.value, 10) + 2; changed = true; }
        if (activeKeys['s'] || activeKeys['arrowdown']) { slideJ2.value = parseInt(slideJ2.value, 10) - 2; changed = true; }

        if (changed) updateJointsFromSliders();
    }

    function exportPythonCode() {
        fetch('/api/export-python', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ joints: kinematics.jointAngles })
        })
        .then(res => res.blob())
        .then(blob => {
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = '6dof_arm_robotic_head_control.py';
            document.body.appendChild(a);
            a.click();
            a.remove();
        })
        .catch(err => console.error('Failed to export code:', err));
    }

    function setupMp3MusicPlayer() {
        const mp3FileInput = document.getElementById('mp3FileInput');
        const btnUploadMp3 = document.getElementById('btnUploadMp3');
        const selectMp3Song = document.getElementById('selectMp3Song');
        const selectMusicConductor = document.getElementById('selectMusicConductor');
        const btnPlayMusic = document.getElementById('btnPlayMusic');
        const btnPauseMusic = document.getElementById('btnPauseMusic');
        const btnStopMusic = document.getElementById('btnStopMusic');
        const musicTrackName = document.getElementById('musicTrackName');
        const musicTimeVal = document.getElementById('musicTimeVal');
        const slideMusicProgress = document.getElementById('slideMusicProgress');
        const slideMusicVolume = document.getElementById('slideMusicVolume');
        const valMusicVolume = document.getElementById('valMusicVolume');

        if (!selectMp3Song) return;

        const musicAudio = new Audio();
        musicAudio.crossOrigin = "anonymous";

        let audioCtx = null;
        let analyser = null;
        let sourceNode = null;
        let isSeeking = false;
        let lastMotorState = false;

        const initAudioAnalyser = () => {
            if (audioCtx) return;
            try {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                sourceNode = audioCtx.createMediaElementSource(musicAudio);
                analyser = audioCtx.createAnalyser();
                analyser.fftSize = 128;
                sourceNode.connect(analyser);
                analyser.connect(audioCtx.destination);
            } catch (e) {
                console.warn('Web Audio API music analyser init warning:', e);
            }
        };

        const loadAudioList = () => {
            fetch('/api/audio/list')
                .then(res => res.json())
                .then(data => {
                    selectMp3Song.innerHTML = '';
                    const files = data.files || [];
                    if (files.length === 0) {
                        const opt = document.createElement('option');
                        opt.value = '';
                        opt.textContent = 'No MP3 files in audio/ folder yet. Import one!';
                        selectMp3Song.appendChild(opt);
                    } else {
                        files.forEach((f, idx) => {
                            const opt = document.createElement('option');
                            opt.value = f;
                            opt.textContent = `🎵 ${f}`;
                            if (idx === 0) opt.selected = true;
                            selectMp3Song.appendChild(opt);
                        });
                        if (musicTrackName && files.length > 0) {
                            musicTrackName.textContent = `Track: ${selectMp3Song.value}`;
                        }
                    }
                })
                .catch(err => console.error('Failed to list audio files:', err));
        };

        loadAudioList();

        if (btnUploadMp3 && mp3FileInput) {
            btnUploadMp3.addEventListener('click', () => mp3FileInput.click());

            mp3FileInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;

                btnUploadMp3.textContent = '⏳ Uploading MP3 to static/audio/ subfolder...';
                btnUploadMp3.disabled = true;

                const reader = new FileReader();
                reader.onload = (event) => {
                    const b64 = event.target.result.split(',')[1];
                    fetch('/api/audio/upload', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            filename: file.name,
                            data_b64: b64
                        })
                    })
                    .then(res => res.json())
                    .then(resData => {
                        btnUploadMp3.textContent = '📁 Import MP3 to static/audio/ Folder';
                        btnUploadMp3.disabled = false;
                        if (resData.success) {
                            console.log('MP3 imported successfully:', resData);
                            loadAudioList();
                            setTimeout(() => {
                                selectMp3Song.value = resData.filename;
                                if (musicTrackName) musicTrackName.textContent = `Track: ${resData.filename}`;
                            }, 200);
                        } else {
                            alert('Failed to upload MP3: ' + (resData.error || 'Unknown error'));
                        }
                    })
                    .catch(err => {
                        btnUploadMp3.textContent = '📁 Import MP3 to static/audio/ Folder';
                        btnUploadMp3.disabled = false;
                        alert('Upload error: ' + err.message);
                    });
                };
                reader.readAsDataURL(file);
            });
        }

        if (selectMp3Song) {
            selectMp3Song.addEventListener('change', () => {
                const file = selectMp3Song.value;
                if (file) {
                    if (musicTrackName) musicTrackName.textContent = `Track: ${file}`;
                    musicAudio.src = `/audio/${file}`;
                }
            });
        }

        if (btnPlayMusic) {
            btnPlayMusic.addEventListener('click', () => {
                const file = selectMp3Song.value;
                if (!file) {
                    alert('Please import or select an MP3 file first!');
                    return;
                }

                if (audioCtx && audioCtx.state === 'suspended') {
                    audioCtx.resume();
                }
                initAudioAnalyser();

                const currentSrc = musicAudio.src;
                if (!currentSrc || !currentSrc.endsWith(`/audio/${file}`)) {
                    musicAudio.src = `/audio/${file}`;
                }

                musicAudio.play().then(() => {
                    const condStyle = selectMusicConductor ? selectMusicConductor.value : 'Orchestra Conductor';
                    applyPresetPose(condStyle);
                }).catch(err => console.error('Play music error:', err));
            });
        }

        if (btnPauseMusic) {
            btnPauseMusic.addEventListener('click', () => {
                musicAudio.pause();
                appAPI.setMouthEnergized(false);
                appAPI.setNeckPulsating(false);
            });
        }

        if (btnStopMusic) {
            btnStopMusic.addEventListener('click', () => {
                musicAudio.pause();
                musicAudio.currentTime = 0;
                appAPI.setMouthEnergized(false);
                appAPI.setNeckPulsating(false);
                applyPresetPose('Home / Rest');
            });
        }

        if (slideMusicVolume) {
            slideMusicVolume.addEventListener('input', (e) => {
                const vol = parseInt(e.target.value, 10);
                musicAudio.volume = vol / 100;
                if (valMusicVolume) valMusicVolume.textContent = `${vol}%`;
            });
        }

        if (slideMusicProgress) {
            slideMusicProgress.addEventListener('mousedown', () => { isSeeking = true; });
            slideMusicProgress.addEventListener('mouseup', () => {
                isSeeking = false;
                if (musicAudio.duration) {
                    musicAudio.currentTime = (slideMusicProgress.value / 100) * musicAudio.duration;
                }
            });
            slideMusicProgress.addEventListener('input', () => {
                if (musicAudio.duration) {
                    const cur = (slideMusicProgress.value / 100) * musicAudio.duration;
                    if (musicTimeVal) musicTimeVal.textContent = `${formatTime(cur)} / ${formatTime(musicAudio.duration)}`;
                }
            });
        }

        musicAudio.addEventListener('timeupdate', () => {
            if (!isSeeking && musicAudio.duration) {
                const pct = (musicAudio.currentTime / musicAudio.duration) * 100;
                if (slideMusicProgress) slideMusicProgress.value = pct;
                if (musicTimeVal) musicTimeVal.textContent = `${formatTime(musicAudio.currentTime)} / ${formatTime(musicAudio.duration)}`;
            }
        });

        musicAudio.addEventListener('ended', () => {
            appAPI.setMouthEnergized(false);
            appAPI.setNeckPulsating(false);
            applyPresetPose('Home / Rest');
        });

        const dataArray = new Uint8Array(64);

        const monitorMusicLipSyncAndConductor = () => {
            requestAnimationFrame(monitorMusicLipSyncAndConductor);

            if (!musicAudio.paused && analyser) {
                analyser.getByteFrequencyData(dataArray);
                let sum = 0;
                for (let i = 0; i < dataArray.length; i++) {
                    sum += dataArray[i];
                }
                const avg = sum / dataArray.length;
                const isAudible = avg > 8;

                if (renderer) {
                    renderer.mouthEnergized = isAudible;
                    renderer.neckPulsating = isAudible;
                    if (renderer.lowerJawGroup) {
                        const jawAngle = Math.min(0.65, (avg / 110) * 0.65);
                        renderer.lowerJawGroup.rotation.x = jawAngle;
                    }
                }

                if (isAudible !== lastMotorState) {
                    lastMotorState = isAudible;
                    fetch('/api/motor/l298', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ mouth: isAudible, neck: isAudible })
                    }).catch(e => {});
                }

                const condStyle = selectMusicConductor ? selectMusicConductor.value : 'Orchestra Conductor';
                if (activePose !== condStyle) {
                    applyPresetPose(condStyle);
                }
            } else if (musicAudio.paused) {
                if (lastMotorState) {
                    lastMotorState = false;
                    fetch('/api/motor/l298', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ mouth: false, neck: false })
                    }).catch(e => {});
                }
            }
        };

        monitorMusicLipSyncAndConductor();

        function formatTime(sec) {
            if (isNaN(sec) || !isFinite(sec)) return '0:00';
            const m = Math.floor(sec / 60);
            const s = Math.floor(sec % 60);
            return `${m}:${s < 10 ? '0' : ''}${s}`;
        }
    }
});
