/**
 * 6-DOF Robot Arm 3D WebGL Renderer (Three.js)
 * Builds procedural 3D model of a 6-DOF articulated robot arm (6 Servo Motors),
 * along with Robotic Head (L298-driven Talking Mouth & Pulsating Neck),
 * and HC-SR04 Ultrasonic Distance Sensor.
 */

class Hexapod3DRenderer {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.scene = new THREE.Scene();

        // Camera setup
        this.camera = new THREE.PerspectiveCamera(
            45,
            this.container.clientWidth / this.container.clientHeight,
            1,
            5000
        );
        this.camera.position.set(380, 280, 420);

        // Renderer setup
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.container.appendChild(this.renderer.domElement);

        // Orbit Controls
        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.controls.maxPolarAngle = Math.PI / 2 + 0.1;
        this.controls.target.set(0, 110, 0);

        // Hardware State Flags
        this.mouthEnergized = false; // L298 Channel 1
        this.neckPulsating = false;  // L298 Channel 2
        this.sensorDistances = { front: 45, rear: 120, left: 80, right: 65 };

        // Setup Lighting & Environment
        this.setupEnvironment();

        // Build 6-DOF Robot Arm 3D Hierarchy
        this.buildRobotArm();

        // Window resize event listener
        window.addEventListener('resize', () => this.onWindowResize());
    }

    setupEnvironment() {
        this.scene.background = new THREE.Color(0x0b0e14);
        this.scene.fog = new THREE.FogExp2(0x0b0e14, 0.0008);

        const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
        this.scene.add(ambientLight);

        const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
        dirLight.position.set(250, 450, 200);
        dirLight.castShadow = true;
        dirLight.shadow.mapSize.width = 2048;
        dirLight.shadow.mapSize.height = 2048;
        dirLight.shadow.camera.near = 100;
        dirLight.shadow.camera.far = 1500;
        this.scene.add(dirLight);

        const pointLight = new THREE.PointLight(0x00f0ff, 1.5, 600);
        pointLight.position.set(0, 180, 0);
        this.scene.add(pointLight);

        const grid = new THREE.GridHelper(1600, 32, 0x00f0ff, 0x1e293b);
        grid.position.y = 0;
        this.scene.add(grid);

        const planeGeo = new THREE.PlaneGeometry(2000, 2000);
        const planeMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.8 });
        const ground = new THREE.Mesh(planeGeo, planeMat);
        ground.rotation.x = -Math.PI / 2;
        ground.receiveShadow = true;
        this.scene.add(ground);
    }

    buildRobotArm() {
        this.armGroup = new THREE.Group();
        this.scene.add(this.armGroup);

        // 1. Heavy Base Station Pedestal
        const basePedestalGeo = new THREE.CylinderGeometry(90, 110, 20, 32);
        const basePedestalMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, metalness: 0.8, roughness: 0.3 });
        this.basePedestal = new THREE.Mesh(basePedestalGeo, basePedestalMat);
        this.basePedestal.position.y = 10;
        this.basePedestal.castShadow = true;
        this.basePedestal.receiveShadow = true;
        this.armGroup.add(this.basePedestal);

        // Base Ring Light
        const ringGeo = new THREE.RingGeometry(35, 42, 32);
        const ringMat = new THREE.MeshBasicMaterial({ color: 0x00f0ff, side: THREE.DoubleSide });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 10.5;
        this.basePedestal.add(ring);

        // 2. Robotic Head Assembly with Talking Mouth & Neck (Mounted on Base Side)
        this.buildNeckAndMouth();

        // 3. HC-SR04 Ultrasonic Rangefinder (Front of Base)
        this.buildUltrasonicSensor();

        // 4. Joint 1: Base Turntable / Rotation (J1 Yaw around Y-axis) - Servo #1
        this.j1Group = new THREE.Group();
        this.j1Group.position.y = 20; // Atop base pedestal
        this.armGroup.add(this.j1Group);

        const j1TurntableGeo = new THREE.CylinderGeometry(55, 65, 30, 24);
        const j1Mat = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.9, roughness: 0.2 });
        const j1Mesh = new THREE.Mesh(j1TurntableGeo, j1Mat);
        j1Mesh.position.y = 15;
        j1Mesh.castShadow = true;
        this.j1Group.add(j1Mesh);

        // Shoulder Tower Supports
        const towerGeo = new THREE.BoxGeometry(20, 50, 40);
        const towerMat = new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.8 });
        const towerLeft = new THREE.Mesh(towerGeo, towerMat);
        towerLeft.position.set(-22, 50, 0);
        towerLeft.castShadow = true;
        const towerRight = new THREE.Mesh(towerGeo, towerMat);
        towerRight.position.set(22, 50, 0);
        towerRight.castShadow = true;
        this.j1Group.add(towerLeft);
        this.j1Group.add(towerRight);

        // 5. Joint 2: Shoulder Pivot Hinge (J2 Pitch around Z-axis) - Servo #2
        this.j2Group = new THREE.Group();
        this.j2Group.position.set(0, 60, 0);
        this.j1Group.add(this.j2Group);

        const shoulderJointGeo = new THREE.CylinderGeometry(16, 16, 48, 20);
        shoulderJointGeo.rotateZ(Math.PI / 2);
        const jointMat = new THREE.MeshStandardMaterial({ color: 0x0284c7, metalness: 0.9, roughness: 0.2 });
        const shoulderJointMesh = new THREE.Mesh(shoulderJointGeo, jointMat);
        shoulderJointMesh.castShadow = true;
        this.j2Group.add(shoulderJointMesh);

        // Upper Arm Link (Length: 110 mm)
        const upperArmGeo = new THREE.BoxGeometry(24, 110, 32);
        upperArmGeo.translate(0, 55, 0);
        const upperArmMat = new THREE.MeshStandardMaterial({ color: 0x0284c7, metalness: 0.7, roughness: 0.3 });
        const upperArmMesh = new THREE.Mesh(upperArmGeo, upperArmMat);
        upperArmMesh.castShadow = true;
        this.j2Group.add(upperArmMesh);

        // 6. Joint 3: Elbow Pivot Hinge (J3 Pitch around Z-axis) - Servo #3
        this.j3Group = new THREE.Group();
        this.j3Group.position.set(0, 110, 0);
        this.j2Group.add(this.j3Group);

        const elbowJointGeo = new THREE.CylinderGeometry(14, 14, 40, 20);
        elbowJointGeo.rotateZ(Math.PI / 2);
        const elbowJointMesh = new THREE.Mesh(elbowJointGeo, jointMat);
        elbowJointMesh.castShadow = true;
        this.j3Group.add(elbowJointMesh);

        // Forearm Link (Length: 120 mm)
        const forearmGeo = new THREE.BoxGeometry(20, 120, 26);
        forearmGeo.translate(0, 60, 0);
        const forearmMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, metalness: 0.8, roughness: 0.2 });
        const forearmMesh = new THREE.Mesh(forearmGeo, forearmMat);
        forearmMesh.castShadow = true;
        this.j3Group.add(forearmMesh);

        // 7. Joint 4: Wrist Pitch Hinge (J4 Pitch around Z-axis) - Servo #4
        this.j4Group = new THREE.Group();
        this.j4Group.position.set(0, 120, 0);
        this.j3Group.add(this.j4Group);

        const wristJointGeo = new THREE.CylinderGeometry(12, 12, 32, 16);
        wristJointGeo.rotateZ(Math.PI / 2);
        const wristJointMesh = new THREE.Mesh(wristJointGeo, jointMat);
        wristJointMesh.castShadow = true;
        this.j4Group.add(wristJointMesh);

        // Wrist Link (Length: 45 mm)
        const wristLinkGeo = new THREE.BoxGeometry(16, 45, 20);
        wristLinkGeo.translate(0, 22.5, 0);
        const wristLinkMat = new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.8 });
        const wristLinkMesh = new THREE.Mesh(wristLinkGeo, wristLinkMat);
        wristLinkMesh.castShadow = true;
        this.j4Group.add(wristLinkMesh);

        // 8. Joint 5: Wrist Roll Swivel Joint (J5 Wrist Roll around Y-axis) - Servo #5 (6th Servo Motor)
        this.j5RollGroup = new THREE.Group();
        this.j5RollGroup.position.set(0, 45, 0);
        this.j4Group.add(this.j5RollGroup);

        const rollJointGeo = new THREE.CylinderGeometry(14, 14, 20, 20);
        const rollJointMat = new THREE.MeshStandardMaterial({ color: 0xa855f7, metalness: 0.9, roughness: 0.2 });
        const rollJointMesh = new THREE.Mesh(rollJointGeo, rollJointMat);
        rollJointMesh.position.y = 10;
        rollJointMesh.castShadow = true;
        this.j5RollGroup.add(rollJointMesh);

        // Wrist Roll Shaft
        const rollShaftGeo = new THREE.BoxGeometry(14, 25, 18);
        rollShaftGeo.translate(0, 12.5, 0);
        const rollShaftMesh = new THREE.Mesh(rollShaftGeo, wristLinkMat);
        rollShaftMesh.position.y = 10;
        rollShaftMesh.castShadow = true;
        this.j5RollGroup.add(rollShaftMesh);

        // 9. Joint 6: Gripper Claw Assembly (J6 Gripper Open/Close) - Servo #6
        this.j6GripperGroup = new THREE.Group();
        this.j6GripperGroup.position.set(0, 35, 0);
        this.j5RollGroup.add(this.j6GripperGroup);

        // Gripper Palm Mount
        const palmGeo = new THREE.BoxGeometry(36, 12, 28);
        const palmMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, metalness: 0.9, roughness: 0.2 });
        const palmMesh = new THREE.Mesh(palmGeo, palmMat);
        palmMesh.position.y = 6;
        palmMesh.castShadow = true;
        this.j6GripperGroup.add(palmMesh);

        // Left Claw Finger Group
        this.leftClaw = new THREE.Group();
        this.leftClaw.position.set(-12, 12, 0);
        this.j6GripperGroup.add(this.leftClaw);

        const clawFingerGeo = new THREE.BoxGeometry(6, 45, 12);
        clawFingerGeo.translate(0, 22.5, 0);
        const clawMat = new THREE.MeshStandardMaterial({ color: 0xef4444, metalness: 0.9, roughness: 0.1 });
        const leftClawMesh = new THREE.Mesh(clawFingerGeo, clawMat);
        leftClawMesh.castShadow = true;
        this.leftClaw.add(leftClawMesh);

        // Left Rubber Tip Pad
        const padGeo = new THREE.BoxGeometry(4, 12, 10);
        const padMat = new THREE.MeshStandardMaterial({ color: 0x22c55e });
        const leftPad = new THREE.Mesh(padGeo, padMat);
        leftPad.position.set(4, 38, 0);
        this.leftClaw.add(leftPad);

        // Right Claw Finger Group
        this.rightClaw = new THREE.Group();
        this.rightClaw.position.set(12, 12, 0);
        this.j6GripperGroup.add(this.rightClaw);

        const rightClawMesh = new THREE.Mesh(clawFingerGeo, clawMat);
        rightClawMesh.castShadow = true;
        this.rightClaw.add(rightClawMesh);

        const rightPad = new THREE.Mesh(padGeo, padMat);
        rightPad.position.set(-4, 38, 0);
        this.rightClaw.add(rightPad);
    }

    buildNeckAndMouth() {
        this.frontHeadGroup = new THREE.Group();
        this.frontHeadGroup.position.set(0, 20, 75);
        this.armGroup.add(this.frontHeadGroup);

        // 1. Pulsating Neck
        this.neckGroup = new THREE.Group();
        this.neckGroup.rotation.x = -Math.PI / 3;
        this.frontHeadGroup.add(this.neckGroup);

        const neckMat = new THREE.MeshStandardMaterial({
            color: 0x8b5cf6,
            roughness: 0.3,
            metalness: 0.7
        });

        this.neckRings = [];
        for (let r = 0; r < 3; r++) {
            const ringGeo = new THREE.TorusGeometry(16 - r * 1.5, 3.5, 12, 24);
            const ringMesh = new THREE.Mesh(ringGeo, neckMat);
            ringMesh.position.z = r * 12 + 8;
            this.neckGroup.add(ringMesh);
            this.neckRings.push(ringMesh);
        }

        // Head Base Frame
        this.headBase = new THREE.Group();
        this.headBase.position.z = 44;
        this.headBase.rotation.x = Math.PI / 3;
        this.neckGroup.add(this.headBase);

        // Head Skull
        const upperHeadGeo = new THREE.BoxGeometry(28, 12, 24);
        const headMat = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.8 });
        const upperHead = new THREE.Mesh(upperHeadGeo, headMat);
        upperHead.position.set(0, 5, 12);
        this.headBase.add(upperHead);

        // Cyan Head Eye LEDs
        const eyeGeo = new THREE.SphereGeometry(4, 12, 12);
        const eyeMat = new THREE.MeshBasicMaterial({ color: 0x00f0ff });
        const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
        leftEye.position.set(-8, 7, 24);
        const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
        rightEye.position.set(8, 7, 24);
        this.headBase.add(leftEye);
        this.headBase.add(rightEye);

        // 2. Articulated Lower Jaw / Mouth (Driven by L298 Channel 1 DC Motor)
        this.lowerJawGroup = new THREE.Group();
        this.lowerJawGroup.position.set(0, -2, 8);
        this.headBase.add(this.lowerJawGroup);

        const lowerJawGeo = new THREE.BoxGeometry(24, 7, 20);
        lowerJawGeo.translate(0, -3.5, 10);
        const jawMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, metalness: 0.9, roughness: 0.2 });
        const lowerJawMesh = new THREE.Mesh(lowerJawGeo, jawMat);
        this.lowerJawGroup.add(lowerJawMesh);

        // Chrome Teeth inside mouth
        const teethMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, metalness: 0.9 });
        for (let t = -8; t <= 8; t += 4) {
            const toothGeo = new THREE.ConeGeometry(1.8, 4, 4);
            const tooth = new THREE.Mesh(toothGeo, teethMat);
            tooth.position.set(t, 0, 18);
            tooth.rotation.x = Math.PI;
            this.lowerJawGroup.add(tooth);
        }
    }

    buildUltrasonicSensor() {
        this.sensorGroup = new THREE.Group();
        this.sensorGroup.position.set(0, 22, -80);
        this.sensorGroup.rotation.y = Math.PI;
        this.armGroup.add(this.sensorGroup);

        const pcbGeo = new THREE.BoxGeometry(40, 18, 5);
        const pcbMat = new THREE.MeshStandardMaterial({ color: 0x1d4ed8, roughness: 0.3 });
        const pcb = new THREE.Mesh(pcbGeo, pcbMat);
        pcb.castShadow = true;
        this.sensorGroup.add(pcb);

        const barrelGeo = new THREE.CylinderGeometry(6, 6, 10, 16);
        const barrelMat = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, metalness: 0.9 });

        const barrelL = new THREE.Mesh(barrelGeo, barrelMat);
        barrelL.rotation.x = Math.PI / 2;
        barrelL.position.set(-10, 0, 5);

        const barrelR = new THREE.Mesh(barrelGeo, barrelMat);
        barrelR.rotation.x = Math.PI / 2;
        barrelR.position.set(10, 0, 5);

        this.sensorGroup.add(barrelL);
        this.sensorGroup.add(barrelR);

        // Beam Cone
        const coneGeo = new THREE.ConeGeometry(35, 90, 16, 1, true);
        coneGeo.rotateX(-Math.PI / 2);
        coneGeo.translate(0, 0, 45);
        const coneMat = new THREE.MeshBasicMaterial({
            color: 0x00f0ff,
            transparent: true,
            opacity: 0.2,
            wireframe: true,
            side: THREE.DoubleSide
        });
        this.sensorCone = new THREE.Mesh(coneGeo, coneMat);
        this.sensorGroup.add(this.sensorCone);
    }

    /**
     * Updates 3D 6-DOF Robot Arm joint rotations (6 Servos), mouth position, and neck pulsation.
     */
    updatePose(bodyState, kinematicsResults) {
        let angles = { j1_base: 0, j2_shoulder: 30, j3_elbow: 45, j4_wrist: 0, j5_wrist_roll: 0, j6_gripper: 50 };

        if (kinematicsResults && kinematicsResults.jointAngles) {
            angles = kinematicsResults.jointAngles;
        } else if (bodyState && bodyState.jointAngles) {
            angles = bodyState.jointAngles;
        }

        // Convert deg to rad for 3D rotations
        const radJ1 = (angles.j1_base * Math.PI) / 180;
        const radJ2 = (angles.j2_shoulder * Math.PI) / 180;
        const radJ3 = (angles.j3_elbow * Math.PI) / 180;
        const radJ4 = (angles.j4_wrist * Math.PI) / 180;
        const radJ5Roll = (((angles.j5_wrist_roll !== undefined ? angles.j5_wrist_roll : 0)) * Math.PI) / 180;
        const gripPct = Math.max(0, Math.min(100, angles.j6_gripper !== undefined ? angles.j6_gripper : angles.j5_gripper || 50));

        // J1: Base Yaw
        if (this.j1Group) this.j1Group.rotation.y = radJ1;

        // J2: Shoulder Pitch
        if (this.j2Group) this.j2Group.rotation.z = -radJ2;

        // J3: Elbow Pitch
        if (this.j3Group) this.j3Group.rotation.z = -radJ3;

        // J4: Wrist Pitch
        if (this.j4Group) this.j4Group.rotation.z = -radJ4;

        // J5: Wrist Roll Swivel (Servo #5)
        if (this.j5RollGroup) this.j5RollGroup.rotation.y = radJ5Roll;

        // J6: Gripper Claw Opening (Servo #6)
        if (this.leftClaw && this.rightClaw) {
            const spread = (gripPct / 100) * 16;
            this.leftClaw.position.x = -8 - spread;
            this.rightClaw.position.x = 8 + spread;
        }

        // Mouth & Neck DC Motor Animations
        if (this.lowerJawGroup) {
            if (this.mouthEnergized) {
                const talkPulse = Math.abs(Math.sin(performance.now() * 0.016)) * 0.55;
                this.lowerJawGroup.rotation.x = talkPulse;
            } else {
                this.lowerJawGroup.rotation.x += (0.0 - this.lowerJawGroup.rotation.x) * 0.25;
            }
        }

        if (this.neckGroup && this.neckRings) {
            const time = performance.now() * 0.012;
            this.neckRings.forEach((ring, idx) => {
                if (this.neckPulsating) {
                    const scale = 1.0 + Math.sin(time + idx * 0.8) * 0.25;
                    ring.scale.set(scale, scale, 1.0);
                } else {
                    ring.scale.set(1.0, 1.0, 1.0);
                }
            });
        }

        if (this.sensorCone) {
            const distCm = this.sensorDistances.front || 45;
            const scaleZ = Math.max(0.2, Math.min(2.5, distCm / 50));
            this.sensorCone.scale.set(scaleZ, scaleZ, scaleZ);
        }
    }

    render() {
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }

    onWindowResize() {
        const parent = (this.renderer && this.renderer.domElement && this.renderer.domElement.parentElement) ? this.renderer.domElement.parentElement : this.container;
        const targetContainer = parent || this.container;
        if (!targetContainer) return;

        const width = targetContainer.clientWidth || targetContainer.offsetWidth || 800;
        const height = targetContainer.clientHeight || targetContainer.offsetHeight || 300;

        if (width > 0 && height > 0) {
            this.container = targetContainer;
            this.camera.aspect = width / height;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(width, height);
        }
    }
}

// Global Alias for backwards compatibility
window.Arm3DRenderer = Hexapod3DRenderer;
