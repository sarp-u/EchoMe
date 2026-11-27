"""
EchoMe — local web UI for Chatterbox Multilingual TTS.

Wraps Resemble AI's Chatterbox model in a small FastAPI service:
  * loads the model once (lazily, in a background thread)
  * exposes a tiny job API so long generations can report progress
  * serves a static single-page front-end
"""

from __future__ import annotations

import base64
import gc
import json
import logging
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import traceback
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

# Set these before torch is imported anywhere.
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from starlette.middleware.base import BaseHTTPMiddleware

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
OUTPUTS_DIR = BASE_DIR / "outputs"
UPLOADS_DIR = BASE_DIR / "uploads"
for _dir in (OUTPUTS_DIR, UPLOADS_DIR):
    _dir.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("echome")

SUPPORTED_LANGUAGES = ["tr", "en"]
LANGUAGE_NAMES = {"tr": "Türkçe", "en": "English"}
MAX_TEXT_CHARS = 6000
MAX_REFERENCE_BYTES = 30 * 1024 * 1024
MAX_REFERENCE_SECONDS = 20.0
ALLOWED_REFERENCE_EXTS = {
    ".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".aiff", ".aif", ".webm",
}
OUTPUT_ID_RE = re.compile(r"^[a-f0-9]{32}$")
REFERENCE_SAMPLE_RATE = 24_000


# ---------------------------------------------------------------------------
# Model manager
# ---------------------------------------------------------------------------

class ModelManager:
    """Loads Chatterbox once and reports its state to the UI."""

    def __init__(self) -> None:
        self.status = "idle"  # idle | loading | ready | error
        self.device: Optional[str] = None
        self.error: Optional[str] = None
        self.model: Any = None
        self.sr: Optional[int] = None
        self.builtin_conds: Any = None
        self.load_seconds: Optional[float] = None
        self.load_started_at: Optional[float] = None
        self.ready = threading.Event()
        self._load_guard = threading.Lock()

    def start(self) -> None:
        threading.Thread(target=self._load, name="chatterbox-loader", daemon=True).start()

    def _load(self) -> None:
        if not self._load_guard.acquire(blocking=False):
            return
        self.status = "loading"
        self.load_started_at = time.time()
        log.info("Loading Chatterbox model …")
        _t0 = time.time()

        # Chatterbox expects perth to expose a watermarker class. If the
        # optional watermarker cannot initialise, fall back to a no-op.
        try:
            import perth
            if perth.PerthImplicitWatermarker is None:
                perth.PerthImplicitWatermarker = perth.DummyWatermarker
        except Exception as exc:  # pragma: no cover - environment specific
            log.warning("perth watermark patch failed: %s", exc)

        import torch

        requested = (os.getenv("CHATTERBOX_DEVICE") or "auto").strip().lower()
        if requested == "auto":
            if torch.backends.mps.is_available():
                device = "mps"
            elif torch.cuda.is_available():
                device = "cuda"
            else:
                device = "cpu"
        else:
            device = requested

        from chatterbox.mtl_tts import ChatterboxMultilingualTTS

        try:
            model = ChatterboxMultilingualTTS.from_pretrained(device=device)
        except Exception as exc:
            if device == "mps":
                log.warning("MPS load failed (%s); retrying on CPU.", exc)
                device = "cpu"
                model = ChatterboxMultilingualTTS.from_pretrained(device=device)
            else:
                raise

        self.model = model
        self.device = device
        self.sr = int(model.sr)
        self.builtin_conds = model.conds
        self.load_seconds = round(time.time() - _t0, 1)
        self.status = "ready"
        self.error = None
        self.ready.set()
        log.info("Model ready on %s in %.1fs (sr=%s)", device, self.load_seconds, self.sr)

    def describe(self) -> dict:
        return {
            "status": self.status,
            "device": self.device,
            "sample_rate": self.sr,
            "error": self.error,
            "load_seconds": self.load_seconds,
        }


MODEL = ModelManager()
GENERATION_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# Job registry
# ---------------------------------------------------------------------------

class JobCancelled(Exception):
    pass


JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()
MAX_JOBS = 40


def _prune_jobs() -> None:
    with JOBS_LOCK:
        if len(JOBS) <= MAX_JOBS:
            return
        finished = sorted(
            (j for j in JOBS.values() if j["status"] in {"done", "error", "cancelled"}),
            key=lambda j: j["created_at"],
        )
        for job in finished[: len(JOBS) - MAX_JOBS]:
            JOBS.pop(job["id"], None)


def _public_job(job: dict) -> dict:
    now = job["finished_at"] or time.time()
    return {
        "id": job["id"],
        "status": job["status"],
        "stage": job["stage"],
        "progress": round(float(job["progress"]), 4),
        "chunks_done": job["chunks_done"],
        "chunks_total": job["chunks_total"],
        "elapsed": round(now - job["created_at"], 1),
        "error": job["error"],
        "result": job["result"],
    }


# ---------------------------------------------------------------------------
# Text chunking
# ---------------------------------------------------------------------------

# Pause profiles: seconds of silence inserted after each punctuation unit.
# `split_clauses` also splits at ;/: (and `split_commas` at ,), which forces
# short pauses instead of relying on the model to invent them.
PAUSE_STYLES: dict[str, dict[str, Any]] = {
    "natural": {
        "label": "Doğal",
        "sentence": 0.18,
        "clause": 0.10,
        "comma": 0.06,
        "paragraph": 0.45,
        "split_clauses": False,
        "split_commas": False,
    },
    "marked": {
        "label": "Belirgin",
        "sentence": 0.28,
        "clause": 0.16,
        "comma": 0.10,
        "paragraph": 0.60,
        "split_clauses": True,
        "split_commas": False,
    },
    "strong": {
        "label": "Güçlü",
        "sentence": 0.40,
        "clause": 0.24,
        "comma": 0.14,
        "paragraph": 0.80,
        "split_clauses": True,
        "split_commas": True,
    },
}

_SENTENCE_SPLIT = re.compile(r"(?<=[.!?…])\s+")
_CLAUSE_SPLIT = re.compile(r"(?<=[;:])\s+")
_ALL_SPLIT = re.compile(r"(?<=[,;:])\s+")
MIN_CLAUSE_CHARS = 18


def _merge_short_clauses(units: list[str], min_chars: int = MIN_CLAUSE_CHARS) -> list[str]:
    """Keep tiny fragments ("Merhaba,") with the next clause.

    A separate synthesis call for an 8-character greeting sounds drawn out and
    costs a full model pass. Sentence-ending fragments are kept apart because
    their pause is intentional; only short comma/semicolon clauses are merged.
    """
    merged: list[str] = []
    for unit in units:
        previous = merged[-1] if merged else ""
        if (
            previous
            and len(previous) < min_chars
            and not previous.rstrip().endswith((".", "!", "?", "…"))
        ):
            merged[-1] = f"{previous} {unit}"
        else:
            merged.append(unit)
    return merged


def _normalise_speech_text(text: str) -> str:
    """Make punctuation predictable before segmentation.

    Chatterbox's own `punc_norm` turns ``...``, ``;`` and ``:`` into commas, so
    those marks would otherwise never produce a full pause. We treat an
    ellipsis as a sentence break and keep the original marks for the model.
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace("...", "…")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    # Space after sentence punctuation, but never inside 3.14 / 1,5 / 12:30.
    text = re.sub(r"([.!?…])(?=[^\s\d.!?…])", r"\1 ", text)
    text = re.sub(r",(?=[^\s\d])", ", ", text)
    text = re.sub(r"([;:])(?=[^\s\d])", r"\1 ", text)
    return text.strip()


def _split_long_unit(unit: str, max_chars: int) -> list[str]:
    """Split an over-long sentence so no call exceeds the model's token cap."""
    pieces: list[str] = []
    rest = unit.strip()
    while len(rest) > max_chars:
        cut = rest.rfind(", ", 0, max_chars)
        if cut < max_chars * 0.45:
            cut = rest.rfind(" ", 0, max_chars)
        if cut <= 0:
            cut = max_chars
        piece = rest[:cut].strip()
        if piece:
            pieces.append(piece)
        rest = rest[cut:].strip()
    if rest:
        pieces.append(rest)
    return pieces


def _pause_after(unit: str, preset: dict[str, Any], paragraph_end: bool) -> float:
    if paragraph_end:
        return float(preset["paragraph"])
    stripped = unit.rstrip()
    if stripped.endswith(("!", "?", ".", "…")):
        return float(preset["sentence"])
    if stripped.endswith((";", ":")):
        return float(preset["clause"])
    if stripped.endswith(","):
        return float(preset["comma"])
    return float(preset["clause"])


def _cap_segments(
    segments: list[dict[str, Any]], max_segments: int = 40, max_chars: int = 210
) -> list[dict[str, Any]]:
    """Merge adjacent segments when a very long text would create too many calls.

    Short, typical inputs are untouched. For 6000-character articles this keeps
    generation time bounded; the model still sees the punctuation inside the
    merged chunk and usually adds its own short pause there.
    """
    while len(segments) > max_segments:
        best_index: Optional[int] = None
        best_length: Optional[int] = None
        for index in range(len(segments) - 1):
            if segments[index]["paragraph_end"]:
                continue
            combined = len(segments[index]["text"]) + 1 + len(segments[index + 1]["text"])
            if combined > max_chars:
                continue
            if best_length is None or combined < best_length:
                best_length = combined
                best_index = index
        if best_index is None:
            break
        left = segments[best_index]
        right = segments[best_index + 1]
        left["text"] = f"{left['text']} {right['text']}"
        left["pause"] = right["pause"]
        left["paragraph_end"] = right["paragraph_end"]
        del segments[best_index + 1]
    return segments


def build_segments(
    text: str, max_chars: int = 210, pause_style: str = "marked"
) -> list[tuple[str, float]]:
    """Split text into synthesis calls and decide the silence after each one.

    Returns ``[(text, pause_after_seconds), ...]``. Pauses are inserted by the
    worker when concatenating audio, which is the only reliable way to make
    Chatterbox honour punctuation: the model has no SSML/pause token support.
    """
    preset = PAUSE_STYLES.get(pause_style, PAUSE_STYLES["marked"])
    text = _normalise_speech_text(text)
    if not text:
        return []

    segments: list[dict[str, Any]] = []
    paragraphs = re.split(r"\n\s*\n+", text)

    for p_index, paragraph in enumerate(paragraphs):
        lines = [line.strip() for line in paragraph.split("\n") if line.strip()]
        for l_index, line in enumerate(lines):
            line = re.sub(r"\s+", " ", line).strip()
            if not line:
                continue

            units: list[str] = []
            for sentence in _SENTENCE_SPLIT.split(line):
                sentence = sentence.strip()
                if not sentence:
                    continue
                if preset["split_clauses"]:
                    pattern = _ALL_SPLIT if preset["split_commas"] else _CLAUSE_SPLIT
                    parts = [part.strip() for part in pattern.split(sentence) if part.strip()]
                    units.extend(parts or [sentence])
                else:
                    units.append(sentence)

            if preset["split_clauses"]:
                units = _merge_short_clauses(units)

            last_line = l_index == len(lines) - 1
            last_paragraph = p_index == len(paragraphs) - 1

            for u_index, unit in enumerate(units):
                last_unit = u_index == len(units) - 1
                paragraph_end = last_unit and last_line and not last_paragraph
                pause = _pause_after(unit, preset, paragraph_end)
                if last_unit and last_line and last_paragraph:
                    pause = 0.0

                pieces = _split_long_unit(unit, max_chars)
                for piece_index, piece in enumerate(pieces):
                    is_last_piece = piece_index == len(pieces) - 1
                    segments.append(
                        {
                            "text": piece,
                            # Intermediate pieces of one long sentence flow on.
                            "pause": pause if is_last_piece else 0.06,
                            "paragraph_end": paragraph_end and is_last_piece,
                        }
                    )

    segments = _cap_segments(segments, max_segments=40, max_chars=max_chars)
    if segments:
        segments[-1]["pause"] = 0.0
    return [(item["text"], round(float(item["pause"]), 3)) for item in segments]


# ---------------------------------------------------------------------------
# Reference audio normalisation
# ---------------------------------------------------------------------------

def _write_reference_wav(src: Path, dst: Path) -> None:
    """Convert any supported upload into a clean 24 kHz mono WAV."""
    errors: list[str] = []

    # 1) libsndfile / librosa (wav, flac, ogg, mp3 in recent libsndfile)
    try:
        import librosa
        import soundfile as sf

        samples, _ = librosa.load(str(src), sr=REFERENCE_SAMPLE_RATE, mono=True)
        if samples.size == 0:
            raise ValueError("Ses dosyası boş görünüyor.")
        samples = samples[: int(REFERENCE_SAMPLE_RATE * MAX_REFERENCE_SECONDS)]
        sf.write(str(dst), samples, REFERENCE_SAMPLE_RATE, subtype="PCM_16")
        return
    except Exception as exc:
        errors.append(str(exc))

    # 2) macOS afconvert handles m4a/aac/webm natively
    if sys.platform == "darwin" and shutil.which("afconvert"):
        try:
            proc = subprocess.run(
                [
                    "afconvert", "-f", "WAVE", "-d", f"LEI16@{REFERENCE_SAMPLE_RATE}",
                    "-c", "1", str(src), str(dst),
                ],
                capture_output=True, timeout=90,
            )
            if proc.returncode == 0 and dst.exists() and dst.stat().st_size > 1024:
                return
            errors.append((proc.stderr or b"").decode(errors="ignore")[:200])
        except Exception as exc:
            errors.append(str(exc))

    raise ValueError(
        "Bu ses dosyası okunamadı. Lütfen WAV (veya MP3/FLAC/M4A) bir dosya deneyin. "
        f"({errors[-1] if errors else 'bilinmeyen hata'})"
    )


def normalize_reference(src: Path) -> tuple[Path, float]:
    dst = src.with_name(f"{src.stem}_norm.wav")
    try:
        _write_reference_wav(src, dst)
        import soundfile as sf

        info = sf.info(str(dst))
        duration = float(info.frames) / float(info.samplerate)
        if duration < 0.6:
            raise ValueError("Referans ses en az 0,6 saniye olmalı.")
        return dst, duration
    except Exception:
        dst.unlink(missing_ok=True)
        raise


def _cleanup_stale_uploads() -> None:
    cutoff = time.time() - 24 * 3600
    try:
        for item in UPLOADS_DIR.rglob("*"):
            if item.is_file() and item.stat().st_mtime < cutoff:
                item.unlink(missing_ok=True)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Generation worker
# ---------------------------------------------------------------------------

def _run_job(
    job: dict,
    text: str,
    language_id: str,
    exaggeration: float,
    cfg_weight: float,
    temperature: float,
    pause_style: str,
    reference: Optional[Path],
    reference_duration: Optional[float],
) -> None:
    job_id = job["id"]
    part_files: list[Path] = []
    try:
        with GENERATION_LOCK:
            if job["cancel"].is_set():
                raise JobCancelled()

            job["status"] = "preparing"
            job["stage"] = "Model hazırlanıyor"
            if not MODEL.ready.wait(timeout=900):
                raise RuntimeError("Model 15 dakika içinde yüklenemedi.")
            if MODEL.status == "error":
                raise RuntimeError(MODEL.error or "Model yüklenemedi.")
            if job["cancel"].is_set():
                raise JobCancelled()

            model = MODEL.model
            sr = MODEL.sr

            segments = build_segments(text, pause_style=pause_style)
            if not segments:
                raise ValueError("Metin boş.")
            job["chunks_total"] = len(segments)

            if reference is not None:
                job["stage"] = "Referans ses analiz ediliyor"
                model.prepare_conditionals(str(reference), exaggeration=exaggeration)
            else:
                # `generate` only swaps `conds.t3`, so reusing the built-in
                # conditionals object cannot leak a previous cloned voice.
                if MODEL.builtin_conds is None:
                    raise RuntimeError(
                        "Bu modelde varsayılan ses bulunamadı. Lütfen bir referans ses yükleyin."
                    )
                model.conds = MODEL.builtin_conds

            import torch
            import torchaudio as ta

            parts: list[tuple[Any, float]] = []
            for index, (segment, pause_after) in enumerate(segments):
                if job["cancel"].is_set():
                    raise JobCancelled()
                job["status"] = "generating"
                job["stage"] = f"Segment {index + 1}/{len(segments)} üretiliyor"
                job["progress"] = index / len(segments)

                wav = model.generate(
                    segment,
                    language_id=language_id,
                    audio_prompt_path=None,
                    exaggeration=exaggeration,
                    cfg_weight=cfg_weight,
                    temperature=temperature,
                )
                parts.append((wav.detach().cpu(), pause_after))
                job["chunks_done"] = index + 1
                job["progress"] = (index + 1) / len(segments)

            if job["cancel"].is_set():
                raise JobCancelled()

            job["stage"] = "Ses birleştiriliyor"
            job["progress"] = 0.985

            if len(parts) == 1:
                audio = parts[0][0]
            else:
                pieces: list[Any] = []
                for i, (part, pause_after) in enumerate(parts):
                    pieces.append(part)
                    if i != len(parts) - 1 and pause_after > 0:
                        pieces.append(
                            torch.zeros(
                                (1, int(sr * pause_after)),
                                dtype=part.dtype,
                            )
                        )
                audio = torch.cat(pieces, dim=-1)

            out_path = OUTPUTS_DIR / f"{job_id}.wav"
            try:
                ta.save(
                    str(out_path),
                    audio.cpu(),
                    sr,
                    encoding="PCM_S",
                    bits_per_sample=16,
                )
            except TypeError:
                ta.save(str(out_path), audio.cpu(), sr)

            duration = round(float(audio.shape[-1]) / sr, 2)
            created_at = datetime.now(timezone.utc)
            stamp = datetime.now().astimezone().strftime("%Y%m%d_%H%M%S")
            download_name = f"echome_{stamp}.wav"

            meta = {
                "id": job_id,
                "filename": download_name,
                "url": f"/api/audio/{job_id}",
                "download_url": f"/api/download/{job_id}",
                "duration": duration,
                "text": text,
                "language": language_id,
                "language_name": LANGUAGE_NAMES.get(language_id, language_id),
                "exaggeration": round(exaggeration, 2),
                "cfg_weight": round(cfg_weight, 2),
                "temperature": round(temperature, 2),
                "pause_style": pause_style,
                "chunks": len(segments),
                "reference_duration": round(reference_duration, 2) if reference_duration else None,
                "created_at": created_at.isoformat(),
                "elapsed": round(time.time() - job["created_at"], 1),
            }
            (OUTPUTS_DIR / f"{job_id}.json").write_text(
                json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
            )

            job["progress"] = 1.0
            job["stage"] = "Tamamlandı"
            job["status"] = "done"
            job["result"] = meta
            job["finished_at"] = time.time()
            log.info(
                "Job %s done in %.1fs (%.1fs audio)",
                job_id,
                time.time() - job["created_at"],
                duration,
            )

    except JobCancelled:
        job["status"] = "cancelled"
        job["stage"] = "İptal edildi"
        job["finished_at"] = time.time()
        log.info("Job %s cancelled", job_id)
    except Exception as exc:
        job["status"] = "error"
        job["stage"] = "Hata oluştu"
        job["error"] = f"{type(exc).__name__}: {exc}"
        job["finished_at"] = time.time()
        log.error("Job %s failed:\n%s", job_id, traceback.format_exc())
    finally:
        for path in part_files:
            path.unlink(missing_ok=True)
        if reference is not None:
            reference.unlink(missing_ok=True)
            reference.with_name(f"{reference.stem}_norm.wav").unlink(missing_ok=True)
        gc.collect()
        try:
            import torch
            if MODEL.device == "mps" and hasattr(torch, "mps"):
                torch.mps.empty_cache()
        except Exception:
            pass


def _start_job(
    text: str,
    language_id: str,
    exaggeration: float,
    cfg_weight: float,
    temperature: float,
    pause_style: str,
    reference: Optional[Path],
    reference_duration: Optional[float],
) -> dict:
    _prune_jobs()
    job_id = uuid.uuid4().hex
    job = {
        "id": job_id,
        "status": "queued",
        "stage": "Sıraya alındı",
        "progress": 0.0,
        "chunks_done": 0,
        "chunks_total": 0,
        "created_at": time.time(),
        "finished_at": None,
        "error": None,
        "result": None,
        "cancel": threading.Event(),
    }
    with JOBS_LOCK:
        JOBS[job_id] = job

    threading.Thread(
        target=_run_job,
        args=(
            job,
            text,
            language_id,
            exaggeration,
            cfg_weight,
            temperature,
            pause_style,
            reference,
            reference_duration,
        ),
        name=f"tts-{job_id[:6]}",
        daemon=True,
    ).start()
    return job


def _load_output_meta(job_id: str) -> Optional[dict]:
    path = OUTPUTS_DIR / f"{job_id}.json"
    if not path.exists():
        return None
    try:
        meta = json.loads(path.read_text(encoding="utf-8"))
        meta["url"] = f"/api/audio/{job_id}"
        meta["download_url"] = f"/api/download/{job_id}"
        return meta
    except Exception:
        return None


def _list_outputs(limit: int = 24) -> list[dict]:
    items: list[dict] = []
    for meta_path in OUTPUTS_DIR.glob("*.json"):
        job_id = meta_path.stem
        if not OUTPUT_ID_RE.match(job_id):
            continue
        if not (OUTPUTS_DIR / f"{job_id}.wav").exists():
            continue
        meta = _load_output_meta(job_id)
        if meta:
            items.append(meta)
    items.sort(key=lambda m: m.get("created_at", ""), reverse=True)
    return items[:limit]


# ---------------------------------------------------------------------------
# Optional password gate (used when the app is exposed to the internet)
# ---------------------------------------------------------------------------

ECHOME_USER = os.getenv("ECHOME_USER", "echome")
ECHOME_PASSWORD = os.getenv("ECHOME_PASSWORD", "")


class BasicAuthMiddleware(BaseHTTPMiddleware):
    """HTTP Basic auth, enabled only when ECHOME_PASSWORD is set.

    Public demos should always set this: a TTS voice-cloning endpoint open to
    the world will be abused and can exhaust the host's resources.
    """

    async def dispatch(self, request, call_next):
        if not ECHOME_PASSWORD or request.url.path == "/healthz":
            return await call_next(request)

        header = request.headers.get("authorization", "")
        scheme, _, encoded = header.partition(" ")
        if scheme.lower() == "basic" and encoded:
            try:
                decoded = base64.b64decode(encoded).decode("utf-8")
                user, _, password = decoded.partition(":")
                if secrets.compare_digest(user, ECHOME_USER) and secrets.compare_digest(
                    password, ECHOME_PASSWORD
                ):
                    return await call_next(request)
            except Exception:
                pass

        return PlainTextResponse(
            "EchoMe: yetkisiz erişim. Kullanıcı adı ve şifre gerekli.",
            status_code=401,
            headers={"WWW-Authenticate": 'Basic realm="EchoMe", charset="UTF-8"'},
        )


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    _cleanup_stale_uploads()
    MODEL.start()
    yield


app = FastAPI(title="EchoMe", version="1.1.0", lifespan=lifespan)
app.add_middleware(BasicAuthMiddleware)


@app.get("/healthz", include_in_schema=False)
async def healthz():
    return {"ok": True, "model": MODEL.status}


@app.get("/api/status")
async def api_status():
    return {
        **MODEL.describe(),
        "languages": [
            {"id": lang, "name": LANGUAGE_NAMES[lang]} for lang in SUPPORTED_LANGUAGES
        ],
        "max_text_chars": MAX_TEXT_CHARS,
        "max_reference_mb": MAX_REFERENCE_BYTES // (1024 * 1024),
        "python": sys.version.split()[0],
        "outputs": len(_list_outputs(limit=999)),
    }


@app.post("/api/jobs")
async def create_job(
    text: str = Form(""),
    language_id: str = Form("tr"),
    exaggeration: float = Form(0.5),
    cfg_weight: float = Form(0.5),
    temperature: float = Form(0.8),
    pause_style: str = Form("marked"),
    reference: Optional[UploadFile] = File(None),
):
    text = (text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Lütfen bir metin girin.")
    if len(text) > MAX_TEXT_CHARS:
        raise HTTPException(
            status_code=400,
            detail=f"Metin çok uzun. En fazla {MAX_TEXT_CHARS} karakter kullanabilirsiniz.",
        )
    if language_id not in SUPPORTED_LANGUAGES:
        raise HTTPException(status_code=400, detail="Desteklenmeyen dil. tr veya en seçin.")
    if not 0.25 <= exaggeration <= 2.0:
        raise HTTPException(status_code=400, detail="Exaggeration 0.25 ile 2.00 arasında olmalı.")
    if not 0.2 <= cfg_weight <= 1.0:
        raise HTTPException(status_code=400, detail="CFG weight 0.20 ile 1.00 arasında olmalı.")
    if not 0.05 <= temperature <= 5.0:
        raise HTTPException(status_code=400, detail="Temperature 0.05 ile 5.00 arasında olmalı.")
    if pause_style not in PAUSE_STYLES:
        raise HTTPException(
            status_code=400,
            detail="Geçersiz duraklama stili. natural, marked veya strong seçin.",
        )
    if len(build_segments(text, pause_style=pause_style)) > 40:
        raise HTTPException(
            status_code=400,
            detail="Metin çok uzun (40+ segment). Lütfen daha kısa bir metin deneyin.",
        )

    active = sum(1 for j in JOBS.values() if j["status"] not in {"done", "error", "cancelled"})
    if active >= 8:
        raise HTTPException(status_code=429, detail="Çok fazla bekleyen iş var, biraz bekleyin.")

    raw_path: Optional[Path] = None
    norm_path: Optional[Path] = None
    ref_duration: Optional[float] = None

    if reference is not None and reference.filename:
        suffix = Path(reference.filename).suffix.lower()
        if suffix not in ALLOWED_REFERENCE_EXTS:
            raise HTTPException(
                status_code=400,
                detail="Desteklenmeyen dosya türü. WAV, MP3, FLAC, OGG veya M4A yükleyin.",
            )
        raw_path = UPLOADS_DIR / f"{uuid.uuid4().hex}{suffix}"
        size = 0
        try:
            with raw_path.open("wb") as handle:
                while True:
                    chunk = await reference.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > MAX_REFERENCE_BYTES:
                        raise HTTPException(
                            status_code=413,
                            detail=f"Ses dosyası çok büyük. En fazla {MAX_REFERENCE_BYTES // (1024 * 1024)} MB.",
                        )
                    handle.write(chunk)
            if size == 0:
                raise HTTPException(status_code=400, detail="Ses dosyası boş.")
            norm_path, ref_duration = await run_in_threadpool(normalize_reference, raw_path)
            raw_path.unlink(missing_ok=True)
            raw_path = None
        except HTTPException:
            if raw_path:
                raw_path.unlink(missing_ok=True)
            if norm_path:
                norm_path.unlink(missing_ok=True)
            raise
        except Exception as exc:
            for path in (raw_path, norm_path):
                if path:
                    path.unlink(missing_ok=True)
            raise HTTPException(status_code=400, detail=str(exc))

    job = _start_job(
        text,
        language_id,
        float(exaggeration),
        float(cfg_weight),
        float(temperature),
        pause_style,
        norm_path,
        ref_duration,
    )
    return {"job_id": job["id"], "status": "queued"}


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str):
    job = JOBS.get(job_id)
    if job is None:
        meta = _load_output_meta(job_id) if OUTPUT_ID_RE.match(job_id) else None
        if meta:
            return {
                "id": job_id,
                "status": "done",
                "stage": "Tamamlandı",
                "progress": 1.0,
                "chunks_done": meta.get("chunks", 1),
                "chunks_total": meta.get("chunks", 1),
                "elapsed": meta.get("elapsed", 0),
                "error": None,
                "result": meta,
            }
        raise HTTPException(status_code=404, detail="İş bulunamadı.")
    return _public_job(job)


@app.post("/api/jobs/{job_id}/cancel")
async def cancel_job(job_id: str):
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="İş bulunamadı.")
    job["cancel"].set()
    if job["status"] == "queued":
        job["stage"] = "İptal ediliyor"
    return {"ok": True}


@app.get("/api/outputs")
async def list_outputs():
    return {"items": _list_outputs()}


def _output_paths(job_id: str) -> tuple[Path, Path]:
    if not OUTPUT_ID_RE.match(job_id):
        raise HTTPException(status_code=404, detail="Kayıt bulunamadı.")
    wav = OUTPUTS_DIR / f"{job_id}.wav"
    meta = OUTPUTS_DIR / f"{job_id}.json"
    if not wav.exists():
        raise HTTPException(status_code=404, detail="Kayıt bulunamadı.")
    return wav, meta


@app.get("/api/audio/{job_id}")
async def get_audio(job_id: str):
    wav, _ = _output_paths(job_id)
    return FileResponse(wav, media_type="audio/wav", headers={"Cache-Control": "no-store"})


@app.get("/api/download/{job_id}")
async def download_audio(job_id: str):
    wav, meta_path = _output_paths(job_id)
    filename = f"echome_{job_id[:8]}.wav"
    if meta_path.exists():
        try:
            filename = json.loads(meta_path.read_text(encoding="utf-8")).get("filename", filename)
        except Exception:
            pass
    return FileResponse(wav, media_type="audio/wav", filename=filename)


@app.delete("/api/outputs/{job_id}")
async def delete_output(job_id: str):
    wav, meta_path = _output_paths(job_id)
    wav.unlink(missing_ok=True)
    meta_path.unlink(missing_ok=True)
    return {"ok": True}


@app.get("/", include_in_schema=False)
async def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8760"))
    uvicorn.run("server:app", host=os.getenv("HOST", "127.0.0.1"), port=port, reload=False)
