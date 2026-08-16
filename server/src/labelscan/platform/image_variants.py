"""Small, bounded derivatives for authenticated catalogue image displays."""

from __future__ import annotations

import threading
from collections import OrderedDict
from io import BytesIO

from PIL import Image, UnidentifiedImageError

from labelscan.platform.raw_images import RawImage

_THUMBNAIL_MAX_SIDE = 480
_THUMBNAIL_QUALITY = 76
_CACHE_MAX_BYTES = 32 * 1024 * 1024


class ImageVariantError(ValueError):
    """The source cannot be converted into the requested display variant."""


def make_thumbnail(source: RawImage) -> RawImage:
    """Return a compact JPEG while preserving the source pixel orientation."""

    try:
        with Image.open(BytesIO(source.content)) as opened:
            opened.load()
            opened.thumbnail(
                (_THUMBNAIL_MAX_SIDE, _THUMBNAIL_MAX_SIDE),
                Image.Resampling.LANCZOS,
            )
            if opened.mode in {"RGBA", "LA"}:
                rgba = opened.convert("RGBA")
                rgb = Image.new("RGB", rgba.size, "white")
                rgb.paste(rgba, mask=rgba.getchannel("A"))
            else:
                rgb = opened.convert("RGB")
            output = BytesIO()
            rgb.save(
                output,
                format="JPEG",
                quality=_THUMBNAIL_QUALITY,
                optimize=True,
                progressive=True,
            )
    except (OSError, UnidentifiedImageError, ValueError) as exc:
        raise ImageVariantError("image thumbnail generation failed") from exc
    return RawImage(content=output.getvalue(), media_type="image/jpeg")


class ThumbnailCache:
    """Process-local LRU containing derivatives only, bounded by encoded bytes."""

    def __init__(self, max_bytes: int = _CACHE_MAX_BYTES) -> None:
        self._max_bytes = max_bytes
        self._bytes = 0
        self._items: OrderedDict[str, RawImage] = OrderedDict()
        self._lock = threading.Lock()

    def get_or_create(self, checksum: str, source: RawImage) -> RawImage:
        with self._lock:
            cached = self._items.get(checksum)
            if cached is not None:
                self._items.move_to_end(checksum)
                return cached

        thumbnail = make_thumbnail(source)
        size = len(thumbnail.content)
        if size > self._max_bytes:
            return thumbnail

        with self._lock:
            existing = self._items.get(checksum)
            if existing is not None:
                self._items.move_to_end(checksum)
                return existing
            self._items[checksum] = thumbnail
            self._bytes += size
            while self._bytes > self._max_bytes and self._items:
                _, evicted = self._items.popitem(last=False)
                self._bytes -= len(evicted.content)
        return thumbnail


thumbnail_cache = ThumbnailCache()
