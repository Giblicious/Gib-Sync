"""Verify an immutable Actions archive before extracting any candidate bytes.

Python standard library only; this is publication tooling, not a plugin/server
runtime dependency. ZIP file modes are never applied to the filesystem.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import os
from pathlib import Path
import re
import stat
import struct
import sys
import zipfile
import zlib

MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_MEMBER_BYTES = 16 * 1024 * 1024
MAX_TOTAL_BYTES = 64 * 1024 * 1024
IO_BYTES = 64 * 1024
PLUGIN_NAMES = ("main.js", "manifest.json", "styles.css", "versions.json")


class ArchiveRejected(ValueError):
    """A publication invariant failed; never include archive data in errors."""


def expected_names(tag: str) -> tuple[str, ...]:
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag):
        raise ArchiveRejected("An immutable numeric release tag is required")
    return (*PLUGIN_NAMES, "release-artifacts.json", f"gib-sync-{tag}.zip")


def _regular_entries(archive: zipfile.ZipFile, names: tuple[str, ...]) -> list[zipfile.ZipInfo]:
    entries = archive.infolist()
    if len(entries) != len(names) or len({entry.filename for entry in entries}) != len(entries):
        raise ArchiveRejected("Archive entries must be exact, unique and complete")
    if {entry.filename for entry in entries} != set(names):
        raise ArchiveRejected("Only the exact flat release filenames are allowed")
    total = 0
    for entry in entries:
        kind = stat.S_IFMT((entry.external_attr >> 16) & 0xFFFF)
        # Some legitimate ZIP writers omit Unix mode/type bits. Such entries
        # are handled only as regular bytes, never as links or special files.
        if entry.is_dir() or entry.external_attr & 0x10 or kind not in (0, stat.S_IFREG):
            raise ArchiveRejected("Archive entries must be regular files, not links or directories")
        if entry.flag_bits & 1 or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            raise ArchiveRejected("Encrypted or unsupported compression is forbidden")
        if not 0 < entry.file_size <= MAX_MEMBER_BYTES or not 0 < entry.compress_size <= MAX_MEMBER_BYTES:
            raise ArchiveRejected("Archive member exceeds its compressed or uncompressed byte budget")
        total += entry.file_size
    if total > MAX_TOTAL_BYTES:
        raise ArchiveRejected("Archive exceeds its total uncompressed byte budget")
    return entries


def _actual_member(packed: bytes, entry: zipfile.ZipInfo) -> tuple[bytes, tuple[int, int]]:
    """Check the actual raw stream; ZipExtFile alone can stop at a forged size."""
    offset = entry.header_offset
    if offset < 0 or offset + 30 > len(packed):
        raise ArchiveRejected("Invalid local member header")
    signature, _version, flags, method, _time, _date, crc, compressed, size, name_size, extra_size = struct.unpack_from("<4s5H3I2H", packed, offset)
    if signature != b"PK\x03\x04" or flags != entry.flag_bits or method != entry.compress_type:
        raise ArchiveRejected("Local and central ZIP headers differ")
    name_start = offset + 30
    name_end = name_start + name_size
    data_start = name_end + extra_size
    data_end = data_start + entry.compress_size
    if data_end > len(packed) or packed[name_start:name_end] != entry.filename.encode("ascii"):
        raise ArchiveRejected("Local filename or compressed range differs from the verified entry")
    if not flags & 8 and (crc != entry.CRC or compressed not in (entry.compress_size, 0xFFFFFFFF) or size not in (entry.file_size, 0xFFFFFFFF)):
        raise ArchiveRejected("Local size or checksum differs from the central entry")
    output = bytearray()

    def accept(part: bytes) -> None:
        if len(output) + len(part) > entry.file_size or len(output) + len(part) > MAX_MEMBER_BYTES:
            raise ArchiveRejected("Actual decompression exceeds its declared size or byte budget")
        output.extend(part)

    if method == zipfile.ZIP_STORED:
        if entry.compress_size != entry.file_size:
            raise ArchiveRejected("Stored member size differs from its actual compressed range")
        accept(packed[data_start:data_end])
    else:
        decoder = zlib.decompressobj(-zlib.MAX_WBITS)
        for cursor in range(data_start, data_end, IO_BYTES):
            pending = packed[cursor:min(cursor + IO_BYTES, data_end)]
            while pending:
                previous = pending
                accept(decoder.decompress(pending, entry.file_size - len(output) + 1))
                if decoder.unused_data:
                    raise ArchiveRejected("Compressed stream contains unexpected trailing bytes")
                pending = decoder.unconsumed_tail
                if pending == previous:
                    raise ArchiveRejected("Compressed stream made no progress")
        # Drain any internal output with the same bound. Do not use an
        # unbounded flush(), which can defeat a decompression limit.
        while not decoder.eof:
            part = decoder.decompress(b"", entry.file_size - len(output) + 1)
            if not part:
                break
            accept(part)
        if not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
            raise ArchiveRejected("Compressed member is truncated or contains trailing data")
    if len(output) != entry.file_size or zlib.crc32(output) & 0xFFFFFFFF != entry.CRC:
        raise ArchiveRejected("Actual member length or CRC differs from its verified metadata")
    range_end = data_end
    if flags & 8:
        descriptor_start = data_end
        if packed[descriptor_start:descriptor_start + 4] == b"PK\x07\x08":
            descriptor_start += 4
        matched = False
        for layout in ("<III", "<IQQ"):
            descriptor_end = descriptor_start + struct.calcsize(layout)
            if descriptor_end <= len(packed) and struct.unpack_from(layout, packed, descriptor_start) == (entry.CRC, entry.compress_size, entry.file_size):
                range_end, matched = descriptor_end, True
                break
        if not matched:
            raise ArchiveRejected("Streaming data descriptor differs from the actual CRC and sizes")
    return bytes(output), (offset, range_end)


def _read_zip(packed: bytes, names: tuple[str, ...]) -> dict[str, bytes]:
    if not 0 < len(packed) <= MAX_ARCHIVE_BYTES:
        raise ArchiveRejected("Compressed archive exceeds its byte budget")
    with zipfile.ZipFile(io.BytesIO(packed)) as archive:
        entries = _regular_entries(archive, names)
        files, ranges = {}, []
        for entry in entries:
            files[entry.filename], data_range = _actual_member(packed, entry)
            ranges.append(data_range)
        ranges.sort()
        if any(first[1] > second[0] for first, second in zip(ranges, ranges[1:])):
            raise ArchiveRejected("ZIP members have overlapping local ranges")
        return files


def verify_bytes(packed: bytes, tag: str, expected_sha256: str) -> dict[str, bytes]:
    names = expected_names(tag)
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", expected_sha256):
        raise ArchiveRejected("The independent workflow archive SHA-256 is required")
    if len(packed) > MAX_ARCHIVE_BYTES:
        raise ArchiveRejected("Compressed archive exceeds its byte budget")
    if "sha256:" + hashlib.sha256(packed).hexdigest() != expected_sha256:
        raise ArchiveRejected("Archive bytes differ from the independent workflow digest")
    files = _read_zip(packed, names)
    embedded = _read_zip(files[f"gib-sync-{tag}.zip"], PLUGIN_NAMES)
    if any(embedded[name] != files[name] for name in PLUGIN_NAMES):
        raise ArchiveRejected("Embedded plugin bytes differ from the exact public assets")
    return files


def extract_verified(archive_path: Path, destination: Path, tag: str, expected_sha256: str) -> None:
    if archive_path.is_symlink() or not archive_path.is_file() or not 0 < archive_path.stat().st_size <= MAX_ARCHIVE_BYTES:
        raise ArchiveRejected("An existing regular bounded archive is required")
    # A bounded read also detects growth after stat; nothing is extracted yet.
    with archive_path.open("rb") as source:
        packed = source.read(MAX_ARCHIVE_BYTES + 1)
    files = verify_bytes(packed, tag, expected_sha256)
    if destination.exists() or destination.is_symlink() or not destination.parent.is_dir():
        raise ArchiveRejected("The extraction destination must be fresh with an existing parent")
    os.mkdir(destination, 0o700)
    for name, body in files.items():
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
        descriptor = os.open(destination / name, flags, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            for offset in range(0, len(body), IO_BYTES):
                output.write(body[offset:offset + IO_BYTES])
            output.flush()
            os.fsync(output.fileno())


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify an exact immutable source archive before safe extraction")
    parser.add_argument("archive", type=Path)
    parser.add_argument("--destination", required=True, type=Path)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--sha256", required=True)
    arguments = parser.parse_args()
    try:
        extract_verified(arguments.archive, arguments.destination, arguments.tag, arguments.sha256)
    except (ArchiveRejected, zipfile.BadZipFile, zlib.error, OSError, UnicodeError):
        print("Candidate archive rejected; no existing destination or source files were overwritten", file=sys.stderr)
        return 1
    print(f"Verified and extracted six exact candidate files for {arguments.tag}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
