"""The voice selector must not accidentally use or delete the wrong reference."""

import io
import shutil
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import server


def silent_wav() -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24_000)
        wav.writeframes(b"\0\0" * 24_000)
    return output.getvalue()


class VoiceSelectionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        voices = root / "voices"
        uploads = root / "uploads"
        voices.mkdir()
        uploads.mkdir()
        (voices / "female.wav").write_bytes(silent_wav())
        self.addCleanup(patch.stopall)
        patch.object(server, "VOICES_DIR", voices).start()
        patch.object(server, "UPLOADS_DIR", uploads).start()
        self.job = patch.object(
            server, "_start_job", return_value={"id": "abc", "status": "queued"}
        ).start()
        self.client = TestClient(server.app)

    def test_demo_voice_is_copied_not_deleted(self) -> None:
        response = self.client.post("/api/jobs", data={"text": "Merhaba.", "voice": "female"})
        self.assertEqual(response.status_code, 200)
        voice = self.job.call_args.args
        self.assertEqual(voice[6], "female")
        self.assertTrue(voice[7].is_relative_to(server.UPLOADS_DIR))
        self.assertEqual(voice[8], 1.0)
        self.assertTrue((server.VOICES_DIR / "female.wav").exists())
        self.assertEqual(voice[7].read_bytes(), (server.VOICES_DIR / "female.wav").read_bytes())

    def test_custom_upload_overrides_demo_voice(self) -> None:
        def normalise(path: Path) -> tuple[Path, float]:
            output = path.with_name(f"{path.stem}_norm.wav")
            shutil.copyfile(path, output)
            return output, 1.0

        with patch.object(server, "normalize_reference", side_effect=normalise):
            response = self.client.post(
                "/api/jobs",
                data={"text": "Merhaba.", "voice": "male"},
                files={"reference": ("mine.wav", silent_wav(), "audio/wav")},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.job.call_args.args[6], "custom")
        self.assertTrue(self.job.call_args.args[7].exists())

    def test_missing_demo_voice_rejected(self) -> None:
        with patch.object(server, "ensure_builtin_voice", return_value=None):
            response = self.client.post("/api/jobs", data={"text": "Merhaba.", "voice": "male"})
        self.assertEqual(response.status_code, 400)
        self.job.assert_not_called()

    def test_default_voice_keeps_original_behaviour(self) -> None:
        response = self.client.post("/api/jobs", data={"text": "Merhaba."})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.job.call_args.args[6:], ("default", None, None))


if __name__ == "__main__":
    unittest.main()
