#!/usr/bin/env python3
import http.server
import socketserver
import json
import os
import sys
import socket
import ssl
import cv2
import base64
import threading
import time
import random
import urllib.parse
import re
from gemini_bridge import GeminiArmBridge
import numpy as np

PORT = int(os.environ.get("PORT", 1090))
HOST = os.environ.get("HOST", os.environ.get("IP", "127.0.0.1"))
DIRECTORY = os.environ.get("DIRECTORY", os.path.join(os.path.dirname(os.path.abspath(__file__)), "static"))
AUDIO_DIR = os.path.join(DIRECTORY, "audio")
os.makedirs(AUDIO_DIR, exist_ok=True)

def generate_synthetic_camera_frame():
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    frame[:, :] = (30, 25, 20)
    cv2.putText(frame, "6-DOF ROBOT ARM CAMERA FEED", (110, 200), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 240, 255), 2)
    cv2.putText(frame, "STATUS: Virtual Camera Active", (160, 240), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (160, 255, 160), 1)
    t_str = time.strftime("%H:%M:%S")
    cv2.putText(frame, f"LIVE TIME: {t_str}", (220, 280), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1)
    return frame

# Thread-safe Background Camera Stream (Supports USB Webcams & Picamera2 Raspberry Pi CSI Camera)
class CameraStream:
    def __init__(self, source="usb"):
        self.source = str(source).lower()
        self.cap = None
        self.picam2 = None
        self.frame = None
        self.lock = threading.Lock()
        self.running = True
        self.thread = threading.Thread(target=self._update, daemon=True)
        self.thread.start()

    def set_source(self, source):
        with self.lock:
            self.source = str(source).lower()
            self._close_cameras()

    def _close_cameras(self):
        if self.cap:
            try:
                self.cap.release()
            except Exception:
                pass
            self.cap = None
        if self.picam2:
            try:
                self.picam2.stop()
                self.picam2.close()
            except Exception:
                pass
            self.picam2 = None

    def _update(self):
        while self.running:
            with self.lock:
                cur_source = self.source

            # Option A: Raspberry Pi CSI Camera via Picamera2
            if cur_source in ["csi", "picamera", "raspberry_pi", "ov5647"]:
                if self.picam2 is None:
                    self._close_cameras()
                    try:
                        from picamera2 import Picamera2
                        p = Picamera2()
                        config = p.create_preview_configuration(main={'size': (640, 480)})
                        p.configure(config)
                        p.start()
                        time.sleep(0.3)
                        self.picam2 = p
                        print("Picamera2 CSI Camera initialized successfully")
                    except Exception as e:
                        print("Picamera2 CSI Camera init error:", e)
                        self.picam2 = None
                        time.sleep(1.0)
                        continue

                try:
                    frame_array = self.picam2.capture_array('main')
                    if frame_array is not None and frame_array.size > 0:
                        if frame_array.shape[2] == 4:
                            frame_bgr = cv2.cvtColor(frame_array, cv2.COLOR_RGBA2BGR)
                        else:
                            frame_bgr = frame_array
                        with self.lock:
                            self.frame = frame_bgr
                    time.sleep(0.04)
                except Exception as e:
                    print("CSI frame capture error:", e)
                    self._close_cameras()
                    time.sleep(0.5)

            # Option B: USB Webcam via OpenCV V4L2
            else:
                if self.cap is None or not self.cap.isOpened():
                    self._close_cameras()
                    candidates = [8, 23, 0, 1, 6, 2]
                    if cur_source.isdigit():
                        candidates.insert(0, int(cur_source))
                    candidates = list(dict.fromkeys(candidates))

                    opened = False
                    for idx in candidates:
                        try:
                            cap = cv2.VideoCapture(idx, cv2.CAP_V4L2)
                            if cap.isOpened():
                                ret, frame = cap.read()
                                if ret and frame is not None and frame.size > 0:
                                    self.cap = cap
                                    with self.lock:
                                        self.frame = frame
                                    opened = True
                                    break
                                else:
                                    cap.release()
                        except Exception:
                            pass

                    if not opened:
                        time.sleep(4.0)

                if self.cap and self.cap.isOpened():
                    try:
                        ret, frame = self.cap.read()
                        if ret and frame is not None and frame.size > 0:
                            with self.lock:
                                self.frame = frame
                            time.sleep(0.04)
                        else:
                            self._close_cameras()
                            time.sleep(1.0)
                    except Exception:
                        self._close_cameras()
                        time.sleep(1.0)
                else:
                    time.sleep(0.5)

    def get_frame(self):
        with self.lock:
            if self.frame is not None:
                return self.frame.copy()
        return generate_synthetic_camera_frame()

camera_stream = CameraStream("usb")
gemini_bridge = GeminiArmBridge()

# Simulated Hardware State
motor_state = {
    "mouth_channel1": False, # L298 Channel 1 (DC Motor: Moving Mouth)
    "neck_channel2": False   # L298 Channel 2 (DC Motor: Pulsating Neck)
}

# 6-DOF Joint Servo Angles State (6 Servo Motors)
# J1: Base Yaw (-90 to +90)
# J2: Shoulder Pitch (-90 to +90)
# J3: Elbow Pitch (-135 to +135)
# J4: Wrist Pitch (-90 to +90)
# J5: Wrist Roll / Swivel (-90 to +90)  <- 6th Motor
# J6: Gripper Claw (0=closed, 100=open)
arm_joint_state = {
    "j1_base": 0,
    "j2_shoulder": 30,
    "j3_elbow": 45,
    "j4_wrist": 0,
    "j5_wrist_roll": 0,
    "j6_gripper": 50
}

sensor_state = {
    "front": 45, # cm
    "rear": 120,
    "left": 80,
    "right": 65
}

def update_simulated_sensors():
    while True:
        sensor_state["front"] = max(10, min(200, sensor_state["front"] + random.randint(-2, 2)))
        sensor_state["rear"]  = max(10, min(200, sensor_state["rear"]  + random.randint(-2, 2)))
        sensor_state["left"]  = max(10, min(200, sensor_state["left"]  + random.randint(-2, 2)))
        sensor_state["right"] = max(10, min(200, sensor_state["right"] + random.randint(-2, 2)))
        time.sleep(0.5)

threading.Thread(target=update_simulated_sensors, daemon=True).start()

# Default saved poses library for 6-DOF Robot Arm (6 Servos)
SAVED_POSES = {
    "Home / Rest": {
        "joints": {"j1_base": 0, "j2_shoulder": 0, "j3_elbow": 0, "j4_wrist": 0, "j5_wrist_roll": 0, "j6_gripper": 0},
        "description": "Neutral home rest pose with arm centered and gripper closed"
    },
    "Pick / Reach Floor": {
        "joints": {"j1_base": 0, "j2_shoulder": 45, "j3_elbow": -60, "j4_wrist": -30, "j5_wrist_roll": 0, "j6_gripper": 80},
        "description": "Extended downward pose to pick up an object from floor"
    },
    "Place / Elevated Target": {
        "joints": {"j1_base": 45, "j2_shoulder": 30, "j3_elbow": -20, "j4_wrist": 10, "j5_wrist_roll": 30, "j6_gripper": 10},
        "description": "Elevated angled stance to place an object onto a platform"
    },
    "Reach High": {
        "joints": {"j1_base": 0, "j2_shoulder": 80, "j3_elbow": 45, "j4_wrist": 30, "j5_wrist_roll": 0, "j6_gripper": 0},
        "description": "Fully extended vertical upward reaching stance"
    },
    "Wave Arm Dance": {
        "joints": {"j1_base": 30, "j2_shoulder": 45, "j3_elbow": 30, "j4_wrist": 45, "j5_wrist_roll": 45, "j6_gripper": 80},
        "description": "Dynamic side-to-side waving arm dance with open gripper and wrist roll"
    },
    "Grab & Hold": {
        "joints": {"j1_base": 0, "j2_shoulder": 30, "j3_elbow": -40, "j4_wrist": -20, "j5_wrist_roll": 0, "j6_gripper": 100},
        "description": "Forward reach stance with fully opened claw ready to grab"
    },
    "Salute / Respect": {
        "joints": {"j1_base": -45, "j2_shoulder": 60, "j3_elbow": 60, "j4_wrist": 0, "j5_wrist_roll": -45, "j6_gripper": 0},
        "description": "Raised forearm salute posture with rolled wrist"
    },
    "Arm Disco Dance": {
        "joints": {"j1_base": 60, "j2_shoulder": 50, "j3_elbow": -30, "j4_wrist": 40, "j5_wrist_roll": 60, "j6_gripper": 50},
        "description": "Rhythmic disco arm dance routine"
    },
    "Park Position": {
        "joints": {"j1_base": 0, "j2_shoulder": -80, "j3_elbow": -90, "j4_wrist": -40, "j5_wrist_roll": 0, "j6_gripper": 0},
        "description": "Folded compact park stance for storage"
    },
    "Scan Environment": {
        "joints": {"j1_base": 90, "j2_shoulder": 20, "j3_elbow": 0, "j4_wrist": 0, "j5_wrist_roll": 45, "j6_gripper": 20},
        "description": "90 degree base rotation to scan surrounding area"
    },
    "Gesture Yes": {
        "joints": {"j1_base": 0, "j2_shoulder": 40, "j3_elbow": 20, "j4_wrist": 30, "j5_wrist_roll": 0, "j6_gripper": 50},
        "description": "Nodding arm gesture for Yes"
    },
    "Gesture No": {
        "joints": {"j1_base": 0, "j2_shoulder": 30, "j3_elbow": 30, "j4_wrist": 0, "j5_wrist_roll": 45, "j6_gripper": 50},
        "description": "Side-to-side shaking gesture for No"
    },
    "High Five": {
        "joints": {"j1_base": 0, "j2_shoulder": 65, "j3_elbow": 20, "j4_wrist": 45, "j5_wrist_roll": 0, "j6_gripper": 100},
        "description": "Raised arm stance with open palm for High Five"
    },
    "Orchestra Conductor": {
        "joints": {"j1_base": 0, "j2_shoulder": 40, "j3_elbow": 30, "j4_wrist": 20, "j5_wrist_roll": 30, "j6_gripper": 50},
        "description": "Maestro baton conducting with sweeping base and arm beats"
    },
    "Symphony Maestro Sweep": {
        "joints": {"j1_base": -30, "j2_shoulder": 50, "j3_elbow": 20, "j4_wrist": 35, "j5_wrist_roll": -30, "j6_gripper": 80},
        "description": "Wide sweeping orchestral conducting posture"
    },
    "Rock Concert Conductor": {
        "joints": {"j1_base": 15, "j2_shoulder": 60, "j3_elbow": -20, "j4_wrist": 45, "j5_wrist_roll": 60, "j6_gripper": 100},
        "description": "High energy rock conducting stance with wrist flick accents"
    }
}

class RobotArmRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
        super().end_headers()

    def do_HEAD(self):
        if self.path.startswith("/api/"):
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
        else:
            super().do_HEAD()

    def do_GET(self):
        if self.path.startswith("/api/status"):
            self.send_json({"status": "online", "device": "Raspberry Pi 6-DOF Robot Arm Center", "python_version": sys.version})
        elif self.path.startswith("/api/poses"):
            self.send_json(SAVED_POSES)
        elif self.path.startswith("/api/audio/list"):
            try:
                audio_files = [f for f in os.listdir(AUDIO_DIR) if f.lower().endswith(('.mp3', '.wav', '.ogg', '.m4a', '.flac'))]
                audio_files.sort()
                self.send_json({"files": audio_files})
            except Exception as e:
                self.send_json({"files": [], "error": str(e)})
        elif self.path.startswith("/api/camera/frame"):
            self.serve_camera_frame()
        elif self.path.startswith("/api/sensors/distances"):
            self.send_json(sensor_state)
        elif self.path.startswith("/api/motor/state"):
            self.send_json(motor_state)
        elif self.path.startswith("/api/arm/state"):
            self.send_json(arm_joint_state)
        elif self.path.startswith("/api/tts/speak"):
            query_params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            text_to_speak = query_params.get("text", ["Hello!"])[0]
            voice_id = query_params.get("voice", ["ai_female_us"])[0]

            try:
                from gtts import gTTS
                import io
                clean_text = re.sub(r'\*[^*]*\*', '', text_to_speak).strip()
                if not clean_text:
                    clean_text = "Hello!"

                tld_map = {
                    "ai_female_us": ("en", "com"),
                    "ai_male_us": ("en", "us"),
                    "ai_male_uk": ("en", "co.uk"),
                    "ai_female_uk": ("en", "co.uk"),
                }

                lang, tld = tld_map.get(voice_id, ("en", "com"))
                tts = gTTS(text=clean_text, lang=lang, tld=tld)
                mp3_fp = io.BytesIO()
                tts.write_to_fp(mp3_fp)
                mp3_fp.seek(0)
                audio_bytes = mp3_fp.read()

                self.send_response(200)
                self.send_header('Content-type', 'audio/mpeg')
                self.send_header('Cache-Control', 'no-cache')
                self.end_headers()
                self.wfile.write(audio_bytes)
            except Exception as e:
                self.send_json({"error": str(e)}, status=500)
        else:
            super().do_GET()

    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length).decode('utf-8') if content_length > 0 else "{}"
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            data = {}

        if self.path == "/api/motor/l298":
            motor_state["mouth_channel1"] = data.get("mouth", False)
            motor_state["neck_channel2"]  = data.get("neck", False)
            self.send_json({"success": True, "state": motor_state})

        elif self.path == "/api/arm/joints":
            for j in ["j1_base", "j2_shoulder", "j3_elbow", "j4_wrist", "j5_wrist_roll", "j6_gripper"]:
                if j in data:
                    arm_joint_state[j] = float(data[j])
            self.send_json({"success": True, "joints": arm_joint_state})

        elif self.path == "/api/camera/select":
            source = data.get("source", "usb")
            camera_stream.set_source(source)
            self.send_json({"success": True, "active_source": source})

        elif self.path == "/api/gemini/chat":
            user_text = data.get("prompt", "")
            DEFAULT_GEMINI_KEY = base64.b64decode("QVEuQWI4Uk42SU9GSDQ4UXNyWWNLLWEzUnp0OFc5RVZiZG0yTHJWRmlnQlE1Y0RySTBjaHc=").decode("utf-8")
            api_key = data.get("api_key") or os.environ.get("GEMINI_API_KEY") or DEFAULT_GEMINI_KEY
            include_vision = data.get("include_vision", True)

            image_bytes = None
            if include_vision:
                image_bytes = self.capture_camera_bytes()

            result = gemini_bridge.generate_chat_response(api_key, user_text, image_bytes)
            if result.get("action"):
                act = result["action"]
                if act.get("name") == "arm_pose":
                    p_name = act.get("args", {}).get("pose_name")
                    if p_name in SAVED_POSES:
                        arm_joint_state.update(SAVED_POSES[p_name].get("joints", {}))
                elif act.get("name") == "arm_move":
                    for k, v in act.get("args", {}).items():
                        if k in arm_joint_state:
                            try: arm_joint_state[k] = float(v)
                            except (ValueError, TypeError): pass
            self.send_json(result)

        elif self.path == "/api/gemini/voice":
            DEFAULT_GEMINI_KEY = base64.b64decode("QVEuQWI4Uk42SU9GSDQ4UXNyWWNLLWEzUnp0OFc5RVZiZG0yTHJWRmlnQlE1Y0RySTBjaHc=").decode("utf-8")
            api_key = data.get("api_key") or os.environ.get("GEMINI_API_KEY") or DEFAULT_GEMINI_KEY
            audio_b64 = data.get("audio_b64", "")
            mime_type = data.get("mime_type", "audio/webm")
            include_vision = data.get("include_vision", True)

            audio_bytes = base64.b64decode(audio_b64) if audio_b64 else None
            image_bytes = self.capture_camera_bytes() if include_vision else None

            result = gemini_bridge.generate_voice_chat_response(api_key, audio_bytes, mime_type, image_bytes)
            if result.get("action"):
                act = result["action"]
                if act.get("name") == "arm_pose":
                    p_name = act.get("args", {}).get("pose_name")
                    if p_name in SAVED_POSES:
                        arm_joint_state.update(SAVED_POSES[p_name].get("joints", {}))
                elif act.get("name") == "arm_move":
                    for k, v in act.get("args", {}).items():
                        if k in arm_joint_state:
                            try: arm_joint_state[k] = float(v)
                            except (ValueError, TypeError): pass
            self.send_json(result)

        elif self.path == "/api/gemini/gesture":
            frame = self.capture_camera_frame()
            if frame is None:
                self.send_json({"gesture": "None", "finger_count": 0, "action": None})
            else:
                gesture, finger_count, _ = gemini_bridge.detect_hand_gestures(frame)
                action = None
                if gesture == "5_FINGERS_FORWARD":
                    action = {"name": "arm_pose", "args": {"pose_name": "Wave Arm Dance"}}
                elif gesture == "2_FINGERS_WAVE":
                    action = {"name": "arm_pose", "args": {"pose_name": "Grab & Hold"}}
                elif gesture == "1_FINGER_ATTACK":
                    action = {"name": "arm_pose", "args": {"pose_name": "Home / Rest"}}

                self.send_json({
                    "gesture": gesture,
                    "finger_count": finger_count,
                    "action": action
                })

        elif self.path == "/api/export-python":
            python_script = self.generate_hardware_script(data)
            self.send_response(200)
            self.send_header('Content-type', 'application/x-python')
            self.send_header('Content-Disposition', 'attachment; filename="6dof_arm_robotic_head_control.py"')
            self.end_headers()
            self.wfile.write(python_script.encode('utf-8'))

        elif self.path == "/api/save-pose":
            pose_name = data.get("name", "Custom Arm Pose")
            SAVED_POSES[pose_name] = data.get("pose", {})
            self.send_json({"success": True, "message": f"Saved pose '{pose_name}'"})

        elif self.path == "/api/audio/upload":
            filename = data.get("filename", "track.mp3")
            data_b64 = data.get("data_b64", "")
            safe_filename = re.sub(r'[^a-zA-Z0-9_\-\.]', '_', filename)
            if not safe_filename.lower().endswith(('.mp3', '.wav', '.ogg', '.m4a', '.flac')):
                safe_filename += ".mp3"
            
            try:
                raw_bytes = base64.b64decode(data_b64)
                file_path = os.path.join(AUDIO_DIR, safe_filename)
                with open(file_path, "wb") as f:
                    f.write(raw_bytes)
                self.send_json({"success": True, "filename": safe_filename, "url": f"/audio/{safe_filename}"})
            except Exception as e:
                self.send_json({"success": False, "error": str(e)}, status=500)

        elif self.path == "/api/audio/delete":
            filename = data.get("filename", "")
            safe_filename = os.path.basename(filename)
            file_path = os.path.join(AUDIO_DIR, safe_filename)
            if os.path.exists(file_path):
                try:
                    os.remove(file_path)
                    self.send_json({"success": True, "message": f"Deleted {safe_filename}"})
                except Exception as e:
                    self.send_json({"success": False, "error": str(e)}, status=500)
            else:
                self.send_json({"success": False, "error": "File not found"}, status=404)
        else:
            self.send_json({"error": "Endpoint not found"}, status=404)

    def capture_camera_frame(self):
        return camera_stream.get_frame()

    def capture_camera_bytes(self):
        frame = self.capture_camera_frame()
        if frame is None:
            frame = generate_synthetic_camera_frame()
        ret, jpeg = cv2.imencode('.jpg', frame)
        return jpeg.tobytes() if ret else None

    def serve_camera_frame(self):
        jpeg_bytes = self.capture_camera_bytes()
        if jpeg_bytes is None:
            try:
                self.send_response(503)
                self.end_headers()
            except Exception:
                pass
            return
        try:
            self.send_response(200)
            self.send_header('Content-type', 'image/jpeg')
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            self.end_headers()
            self.wfile.write(jpeg_bytes)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def send_json(self, data, status=200):
        try:
            self.send_response(status)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps(data).encode('utf-8'))
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def generate_hardware_script(self, data):
        joints = data.get("joints", arm_joint_state)
        script = f'''#!/usr/bin/env python3
"""
6-DOF Robot Arm Hardware Control Master Script
Integrated 6x Servo Motors (PCA9685 Channels 0-5 for Base, Shoulder, Elbow, Wrist Pitch, Wrist Roll, Gripper),
L298N Dual Motor Controller (Mouth + Neck),
and HC-SR04 Ultrasonic Distance Sensor.
"""

import time
import board
import busio
import RPi.GPIO as GPIO
from adafruit_pca9685 import PCA9685
from adafruit_motor import servo

# --- GPIO Pin Definitions ---
# L298N Motor Driver (Robotic Head Mouth & Neck)
L298_ENA = 18  # Channel 1 PWM Speed Control (Mouth Motor)
L298_IN1 = 23  # Channel 1 Motor Direction
L298_IN2 = 24  # Channel 1 Motor Direction

L298_ENB = 19  # Channel 2 PWM Speed Control (Pulsating Neck Motor)
L298_IN3 = 25  # Channel 2 Motor Direction
L298_IN4 = 8   # Channel 2 Motor Direction

# HC-SR04 Ultrasonic Sensor (Trig / Echo)
TRIG_PIN = 5
ECHO_PIN = 6

# --- Initialize GPIO & Motors ---
GPIO.setmode(GPIO.BCM)
GPIO.setwarnings(False)

GPIO.setup([L298_ENA, L298_IN1, L298_IN2, L298_ENB, L298_IN3, L298_IN4], GPIO.OUT)
pwm_mouth = GPIO.PWM(L298_ENA, 1000)
pwm_neck  = GPIO.PWM(L298_ENB, 1000)
pwm_mouth.start(0)
pwm_neck.start(0)

GPIO.setup(TRIG_PIN, GPIO.OUT)
GPIO.setup(ECHO_PIN, GPIO.IN)
GPIO.output(TRIG_PIN, False)

# Initialize I2C Bus for PCA9685 16-Channel Servo Driver
i2c = busio.I2C(board.SCL, board.SDA)
pca = PCA9685(i2c, address=0x40)
pca.frequency = 50

# 6-DOF Servo Channel Mapping (6 Motors)
SERVO_CHANNELS = {{
    "j1_base": 0,
    "j2_shoulder": 1,
    "j3_elbow": 2,
    "j4_wrist": 3,
    "j5_wrist_roll": 4,
    "j6_gripper": 5
}}

servos = {{
    joint: servo.Servo(pca.channels[ch], min_pulse=500, max_pulse=2500)
    for joint, ch in SERVO_CHANNELS.items()
}}

TARGET_JOINTS = {json.dumps(joints, indent=4)}

def set_mouth_energized(energized):
    """L298 Channel 1: Drives robotic mouth motor."""
    if energized:
        GPIO.output(L298_IN1, GPIO.HIGH)
        GPIO.output(L298_IN2, GPIO.LOW)
        pwm_mouth.ChangeDutyCycle(100)
    else:
        pwm_mouth.ChangeDutyCycle(0)

def set_neck_pulsating(pulsating):
    """L298 Channel 2: Drives pulsating neck motor."""
    if pulsating:
        GPIO.output(L298_IN3, GPIO.HIGH)
        GPIO.output(L298_IN4, GPIO.LOW)
        pwm_neck.ChangeDutyCycle(80)
    else:
        pwm_neck.ChangeDutyCycle(0)

def set_arm_joint(joint_name, angle_deg):
    if joint_name in servos:
        # Convert -90..90 or custom range to 0..180 for servo driver
        srv_angle = max(0, min(180, angle_deg + 90))
        servos[joint_name].angle = srv_angle

def main():
    print("Master 6-DOF Robot Arm Controller Online.")
    print("6x Joint Servos (PCA9685 Ch 0-5) + L298 Head/Neck Driver Ready.")

    set_mouth_energized(True)
    set_neck_pulsating(True)
    time.sleep(1.5)
    set_mouth_energized(False)
    set_neck_pulsating(False)

    for j_name, angle in TARGET_JOINTS.items():
        print(f"Setting {{j_name}} to {{angle}}°")
        set_arm_joint(j_name, angle)

if __name__ == "__main__":
    try:
        main()
    finally:
        GPIO.cleanup()
'''
        return script

class ThreadingReusableTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True
    ssl_context = None

    def get_request(self):
        newsocket, fromaddr = self.socket.accept()
        if self.ssl_context:
            try:
                first_byte = newsocket.recv(1, socket.MSG_PEEK)
                if first_byte and first_byte[0] == 0x16:
                    newsocket = self.ssl_context.wrap_socket(newsocket, server_side=True)
            except Exception:
                pass
        return newsocket, fromaddr

if __name__ == "__main__":
    for i in range(1, len(sys.argv)):
        if sys.argv[i] == "--port" and i + 1 < len(sys.argv):
            PORT = int(sys.argv[i + 1])
        elif sys.argv[i] == "--host" and i + 1 < len(sys.argv):
            HOST = sys.argv[i + 1]

    cert_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cert.pem")
    key_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "key.pem")
    if not (os.path.exists(cert_path) and os.path.exists(key_path)):
        cert_path = "/home/markirgang/Tweedpump/cert.pem"
        key_path = "/home/markirgang/Tweedpump/key.pem"

    ssl_ctx = None
    if os.path.exists(cert_path) and os.path.exists(key_path):
        try:
            ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ssl_ctx.load_cert_chain(certfile=cert_path, keyfile=key_path)
        except Exception as e:
            print(f"SSL cert load warning: {e}")

    display_host = "localhost" if HOST in ["", "0.0.0.0", "127.0.0.1"] else HOST
    print(f"Starting Multithreaded 6-DOF Robot Arm Server on http://{display_host}:{PORT} (http & https supported)")
    bind_host = "" if HOST in ["", "0.0.0.0", "127.0.0.1", "localhost"] else HOST
    with ThreadingReusableTCPServer((bind_host, PORT), RobotArmRequestHandler) as httpd:
        httpd.ssl_context = ssl_ctx
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")
