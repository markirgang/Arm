import cv2
import numpy as np
import base64
import json
import os
from google import genai
from google.genai import types

class GeminiArmBridge:
    def __init__(self):
        self.system_instruction = (
            "You are the friendly, intelligent AI brain of a 6-DOF Robot Arm with 6 servo motors, equipped with an eMeet Pixy camera, microphone, and a robotic head with talking mouth and pulsating neck. "
            "Your job is to:\n"
            "1. Produce warm, friendly, concise, conversational responses and ask the user questions about what they want the robot arm to do.\n"
            "2. Describe what you see in front of you clearly and concisely when presented with camera images.\n"
            "3. Control the 6-DOF robot arm using function calls whenever the user asks the arm to move, pick up objects, reach, roll wrist, wave, salute, or strike a pose.\n"
            "Always keep spoken chat responses natural and concise (1-3 sentences)."
        )

    def detect_hand_gestures(self, frame):
        """
        Analyzes camera frame for hand gestures (skin color segmentation + contour convexity defects)
        Returns: (gesture_name, finger_count, annotated_frame)
        """
        try:
            resized = cv2.resize(frame, (320, 240))
            blur = cv2.GaussianBlur(resized, (5, 5), 0)
            hsv = cv2.cvtColor(blur, cv2.COLOR_BGR2HSV)

            lower_skin = np.array([0, 20, 70], dtype=np.uint8)
            upper_skin = np.array([20, 255, 255], dtype=np.uint8)
            mask = cv2.inRange(hsv, lower_skin, upper_skin)

            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
            mask = cv2.erode(mask, kernel, iterations=1)
            mask = cv2.dilate(mask, kernel, iterations=2)

            contours, _ = cv2.findContours(mask, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
            if not contours:
                return "None", 0, frame

            max_contour = max(contours, key=cv2.contourArea)
            area = cv2.contourArea(max_contour)

            if area < 3000:
                return "None", 0, frame

            hull = cv2.convexHull(max_contour, returnPoints=False)
            if hull is None or len(hull) < 3:
                return "None", 0, frame

            defects = cv2.convexityDefects(max_contour, hull)
            finger_count = 0

            if defects is not None:
                for i in range(defects.shape[0]):
                    s, e, f, d = defects[i, 0]
                    start = tuple(max_contour[s][0])
                    end = tuple(max_contour[e][0])
                    far = tuple(max_contour[f][0])

                    a = np.sqrt((end[0] - start[0])**2 + (end[1] - start[1])**2)
                    b = np.sqrt((far[0] - start[0])**2 + (far[1] - start[1])**2)
                    c = np.sqrt((end[0] - far[0])**2 + (end[1] - far[1])**2)

                    angle = np.arccos((b**2 + c**2 - a**2) / (2 * b * c + 1e-5))

                    if angle <= np.pi / 2 and d > 1200:
                        finger_count += 1

                finger_count += 1

            gesture = "None"
            if finger_count >= 4:
                gesture = "5_FINGERS_FORWARD"
            elif finger_count in [2, 3]:
                gesture = "2_FINGERS_WAVE"
            elif finger_count == 1:
                gesture = "1_FINGER_ATTACK"

            return gesture, finger_count, frame
        except Exception as e:
            return "None", 0, frame

    def generate_chat_response(self, api_key, user_text="", image_bytes=None):
        if not api_key:
            return {
                "text": "Please provide a valid Google Gemini API Key in the settings tab to enable AI vision & voice features.",
                "action": None
            }

        client = genai.Client(api_key=api_key)

        tools = [
            types.Tool(function_declarations=[
                types.FunctionDeclaration(
                    name="arm_move",
                    description="Sets individual joint angles for the 6-DOF Robot Arm (6 Servos).",
                    parameters=types.Schema(
                        type=types.Type.OBJECT,
                        properties={
                            "j1_base": types.Schema(type=types.Type.NUMBER, description="Base rotation angle (-90 to +90 degrees)"),
                            "j2_shoulder": types.Schema(type=types.Type.NUMBER, description="Shoulder pitch angle (-90 to +90 degrees)"),
                            "j3_elbow": types.Schema(type=types.Type.NUMBER, description="Elbow pitch angle (-135 to +135 degrees)"),
                            "j4_wrist": types.Schema(type=types.Type.NUMBER, description="Wrist pitch angle (-90 to +90 degrees)"),
                            "j5_wrist_roll": types.Schema(type=types.Type.NUMBER, description="Wrist roll rotation swivel (-90 to +90 degrees)"),
                            "j6_gripper": types.Schema(type=types.Type.NUMBER, description="Gripper claw open/close percentage (0=closed, 100=open)")
                        }
                    )
                ),
                types.FunctionDeclaration(
                    name="arm_pose",
                    description="Sets robot arm stance or triggers a preset motion pose or routine.",
                    parameters=types.Schema(
                        type=types.Type.OBJECT,
                        properties={
                            "pose_name": types.Schema(
                                type=types.Type.STRING,
                                enum=[
                                    "Home / Rest", "Pick / Reach Floor", "Place / Elevated Target", "Reach High",
                                    "Wave Arm Dance", "Grab & Hold", "Salute / Respect", "Arm Disco Dance",
                                    "Park Position", "Scan Environment", "Gesture Yes", "Gesture No", "High Five"
                                ]
                            )
                        },
                        required=["pose_name"]
                    )
                ),
                types.FunctionDeclaration(
                    name="arm_stop",
                    description="Stops all robot arm movement immediately.",
                    parameters=types.Schema(type=types.Type.OBJECT, properties={})
                )
            ])
        ]

        contents = []

        if image_bytes:
            contents.append(types.Part.from_bytes(
                data=image_bytes,
                mime_type="image/jpeg"
            ))

        prompt_text = user_text if user_text else "Describe what you see through your camera and ask me what you should do next!"
        contents.append(prompt_text)

        config = types.GenerateContentConfig(
            system_instruction=self.system_instruction,
            tools=tools,
            temperature=0.7
        )

        try:
            response = client.models.generate_content(
                model="gemini-3.8-flash",
                contents=contents,
                config=config
            )

            action = None
            text_response = response.text or ""

            if response.function_calls:
                call = response.function_calls[0]
                args_dict = {}
                if hasattr(call.args, "items"):
                    args_dict = {k: v for k, v in call.args.items()}
                elif isinstance(call.args, dict):
                    args_dict = call.args

                action = {
                    "name": call.name,
                    "args": args_dict
                }
                if not text_response:
                    text_response = f"Executing command: {call.name}"

            return {
                "text": text_response,
                "action": action
            }

        except Exception as e:
            return {
                "text": f"Gemini API Error: {str(e)}",
                "action": None
            }

    def generate_voice_chat_response(self, api_key, audio_bytes, mime_type="audio/webm", image_bytes=None):
        if not api_key:
            return {"text": "Please provide a valid Google Gemini API Key.", "action": None}

        client = genai.Client(api_key=api_key)

        tools = [
            types.Tool(function_declarations=[
                types.FunctionDeclaration(
                    name="arm_move",
                    description="Sets individual joint angles for the 6-DOF Robot Arm (6 Servos).",
                    parameters=types.Schema(
                        type=types.Type.OBJECT,
                        properties={
                            "j1_base": types.Schema(type=types.Type.NUMBER),
                            "j2_shoulder": types.Schema(type=types.Type.NUMBER),
                            "j3_elbow": types.Schema(type=types.Type.NUMBER),
                            "j4_wrist": types.Schema(type=types.Type.NUMBER),
                            "j5_wrist_roll": types.Schema(type=types.Type.NUMBER),
                            "j6_gripper": types.Schema(type=types.Type.NUMBER)
                        }
                    )
                ),
                types.FunctionDeclaration(
                    name="arm_pose",
                    description="Sets robot arm stance or triggers a preset motion pose or routine.",
                    parameters=types.Schema(
                        type=types.Type.OBJECT,
                        properties={
                            "pose_name": types.Schema(
                                type=types.Type.STRING,
                                enum=[
                                    "Home / Rest", "Pick / Reach Floor", "Place / Elevated Target", "Reach High",
                                    "Wave Arm Dance", "Grab & Hold", "Salute / Respect", "Arm Disco Dance",
                                    "Park Position", "Scan Environment", "Gesture Yes", "Gesture No", "High Five"
                                ]
                            )
                        },
                        required=["pose_name"]
                    )
                ),
                types.FunctionDeclaration(
                    name="arm_stop",
                    description="Stops all robot arm movement immediately.",
                    parameters=types.Schema(type=types.Type.OBJECT, properties={})
                )
            ])
        ]

        contents = []

        if audio_bytes:
            contents.append(types.Part.from_bytes(
                data=audio_bytes,
                mime_type=mime_type
            ))

        if image_bytes:
            contents.append(types.Part.from_bytes(
                data=image_bytes,
                mime_type="image/jpeg"
            ))

        contents.append(
            "Listen to my spoken voice input in the audio file above.\n"
            "1. Transcribe the exact words I spoke.\n"
            "2. Respond to me concisely in 1-2 friendly, conversational sentences.\n"
            "3. If I asked the 6-DOF robot arm to move, reach, pick up objects, roll wrist, wave, salute, or pose, call the matching tool function.\n\n"
            "Format your text response as:\n"
            "TRANSCRIPTION: [exact spoken words]\n"
            "RESPONSE: [your conversational answer]"
        )

        config = types.GenerateContentConfig(
            system_instruction=self.system_instruction,
            tools=tools,
            temperature=0.7
        )

        try:
            response = client.models.generate_content(
                model="gemini-3.8-flash",
                contents=contents,
                config=config
            )

            action = None
            raw_text = response.text or ""
            user_transcription = ""
            text_response = raw_text

            if "TRANSCRIPTION:" in raw_text:
                parts = raw_text.split("RESPONSE:", 1)
                user_transcription = parts[0].replace("TRANSCRIPTION:", "").strip()
                if len(parts) > 1:
                    text_response = parts[1].strip()

            if response.function_calls:
                call = response.function_calls[0]
                args_dict = {}
                if hasattr(call.args, "items"):
                    args_dict = {k: v for k, v in call.args.items()}
                elif isinstance(call.args, dict):
                    args_dict = call.args

                action = {"name": call.name, "args": args_dict}
                if not text_response:
                    text_response = f"Executing command: {call.name}"

            return {
                "transcription": user_transcription,
                "text": text_response,
                "action": action
            }

        except Exception as e:
            return {"text": f"Gemini Voice Processing Error: {str(e)}", "action": None}
