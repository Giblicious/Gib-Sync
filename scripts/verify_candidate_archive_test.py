"""Synthetic publication-archive regressions; never physical-device evidence."""
import hashlib
import importlib.util
import io
from pathlib import Path
import shutil
import stat
import struct
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile
import zlib

SCRIPT_ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("candidate_archive", SCRIPT_ROOT / "verify-candidate-archive.py")
candidate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(candidate)
TAG = "v1.2.3"
FILES = {"main.js": b"synthetic plugin code\n" * 40, "manifest.json": b'{"version":"1.2.3"}', "styles.css": b"synthetic styles\n", "versions.json": b'{"1.2.3":"1.5.0"}'}


def pack(files, method=zipfile.ZIP_DEFLATED, modes=None):
    output = io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        with zipfile.ZipFile(output, "w") as archive:
            for name, body in files:
                info = zipfile.ZipInfo(name)
                info.create_system = 3
                info.external_attr = ((modes or {}).get(name, stat.S_IFREG | 0o600)) << 16
                info.compress_type = method
                archive.writestr(info, body)
    return output.getvalue()


def streaming_pack(files, method=zipfile.ZIP_DEFLATED):
    class StreamingOutput(io.RawIOBase):
        def __init__(self):
            self.bytes = bytearray()

        def writable(self):
            return True

        def seekable(self):
            return False

        def tell(self):
            return len(self.bytes)

        def write(self, data):
            self.bytes.extend(data)
            return len(data)

    output = StreamingOutput()
    with zipfile.ZipFile(output, "w") as archive:
        for name, body in files:
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            info.compress_type = method
            archive.writestr(info, body)
    return bytes(output.bytes)


def fixture(*, outer_changes=None, embedded=None, method=zipfile.ZIP_DEFLATED, modes=None, extras=()):
    outer = {**FILES, "release-artifacts.json": b'{"syntheticUnitFixture":true}', f"gib-sync-{TAG}.zip": embedded or pack(FILES.items(), method)}
    outer.update(outer_changes or {})
    return pack([*outer.items(), *extras], method, modes)


def digest(packed):
    return "sha256:" + hashlib.sha256(packed).hexdigest()


def headers(packed, name):
    with zipfile.ZipFile(io.BytesIO(packed)) as archive:
        info = archive.getinfo(name)
        local = info.header_offset
    cursor = 0
    while True:
        cursor = packed.index(b"PK\x01\x02", cursor)
        length, extra_length, comment_length = struct.unpack_from("<3H", packed, cursor + 28)
        if packed[cursor + 46:cursor + 46 + length] == name.encode():
            return local, cursor, info
        cursor += 46 + length + extra_length + comment_length


def change_fields(packed, name="main.js", *, crc=None, size=None, compressed=None, flags=None, method=None):
    modified = bytearray(packed)
    local, central, _info = headers(packed, name)
    for value, local_offset, central_offset, fmt in [(crc, 14, 16, "<I"), (size, 22, 24, "<I"), (compressed, 18, 20, "<I"), (flags, 6, 8, "<H"), (method, 8, 10, "<H")]:
        if value is not None:
            struct.pack_into(fmt, modified, local + local_offset, value)
            struct.pack_into(fmt, modified, central + central_offset, value)
    return bytes(modified)


class CandidateArchiveTests(unittest.TestCase):
    def reject(self, packed, pattern=None):
        failures = (candidate.ArchiveRejected, zipfile.BadZipFile, zlib.error)
        if pattern:
            with self.assertRaisesRegex(failures, pattern):
                candidate.verify_bytes(packed, TAG, digest(packed))
        else:
            with self.assertRaises(failures):
                candidate.verify_bytes(packed, TAG, digest(packed))

    def test_exact_deflated_and_stored_bytes_pass(self):
        for method in (zipfile.ZIP_DEFLATED, zipfile.ZIP_STORED):
            files = candidate.verify_bytes(fixture(method=method), TAG, digest(fixture(method=method)))
            self.assertEqual(set(files), set(candidate.expected_names(TAG)))
            self.assertEqual(files["main.js"], FILES["main.js"])

    def test_actions_style_streaming_deflate_descriptors_and_unix_regular_modes(self):
        for embedded_method in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            outer = {**FILES, "release-artifacts.json": b'{"syntheticUnitFixture":true}', f"gib-sync-{TAG}.zip": pack(FILES.items(), embedded_method)}
            packed = streaming_pack(outer.items())
            with zipfile.ZipFile(io.BytesIO(packed)) as archive:
                self.assertTrue(all(entry.flag_bits & 8 for entry in archive.infolist()))
                self.assertTrue(all(stat.S_IFMT(entry.external_attr >> 16) == stat.S_IFREG for entry in archive.infolist()))
            self.assertIn(b"PK\x07\x08", packed)
            self.assertEqual(candidate.verify_bytes(packed, TAG, digest(packed))["main.js"], FILES["main.js"])

    def test_stored_streaming_descriptor_members_also_pass(self):
        outer = {**FILES, "release-artifacts.json": b'{"syntheticUnitFixture":true}', f"gib-sync-{TAG}.zip": streaming_pack(FILES.items(), zipfile.ZIP_STORED)}
        packed = streaming_pack(outer.items(), zipfile.ZIP_STORED)
        self.assertEqual(candidate.verify_bytes(packed, TAG, digest(packed))["styles.css"], FILES["styles.css"])

    def test_corrupt_streaming_descriptor_cannot_hide_behind_valid_central_crc(self):
        outer = {**FILES, "release-artifacts.json": b"{}", f"gib-sync-{TAG}.zip": pack(FILES.items())}
        packed = bytearray(streaming_pack(outer.items()))
        local, _central, info = headers(packed, "main.js")
        name_size, extra_size = struct.unpack_from("<2H", packed, local + 26)
        descriptor = local + 30 + name_size + extra_size + info.compress_size
        self.assertEqual(packed[descriptor:descriptor + 4], b"PK\x07\x08")
        struct.pack_into("<I", packed, descriptor + 4, info.CRC ^ 1)
        self.reject(bytes(packed), "data descriptor")

    def test_independent_workflow_digest_is_required(self):
        with self.assertRaises(candidate.ArchiveRejected):
            candidate.verify_bytes(fixture(), TAG, "sha256:" + "0" * 64)

    def test_unsafe_tag_is_rejected(self):
        for tag in ("main", "v1.2.3/../../source", "v1.2.3\nlatest"):
            with self.assertRaises(candidate.ArchiveRejected):
                candidate.verify_bytes(fixture(), tag, digest(fixture()))

    def test_duplicate_entry_is_rejected(self):
        self.reject(fixture(extras=[("main.js", b"duplicate")]), "unique")

    def test_extra_traversal_cannot_overwrite_source_verifier(self):
        self.reject(fixture(extras=[("../source/scripts/release-artifacts.mjs", b"incorrect")]))

    def test_traversal_replacement_with_exact_count_is_rejected(self):
        outer = {**FILES, "release-artifacts.json": b"{}", f"gib-sync-{TAG}.zip": pack(FILES.items())}
        outer["../source/scripts/release-artifacts.mjs"] = outer.pop("main.js")
        self.reject(pack(outer.items()), "flat")

    def test_symlink_and_special_modes_are_rejected(self):
        for mode in (stat.S_IFLNK | 0o777, stat.S_IFIFO | 0o600, stat.S_IFDIR | 0o700, stat.S_IFSOCK | 0o600):
            self.reject(fixture(modes={"main.js": mode}), "regular")

    def test_directory_extra_is_rejected(self):
        self.reject(fixture(extras=[("directory/", b"")]))

    def test_dos_directory_mode_is_rejected(self):
        packed = bytearray(fixture())
        _local, central, _info = headers(packed, "main.js")
        old = struct.unpack_from("<I", packed, central + 38)[0]
        struct.pack_into("<I", packed, central + 38, old | 0x10)
        self.reject(bytes(packed), "regular")

    def test_encrypted_and_unknown_compression_are_rejected(self):
        self.reject(change_fields(fixture(), flags=1), "Encrypted")
        self.reject(change_fields(fixture(), method=99), "unsupported")

    def test_zero_member_is_rejected(self):
        self.reject(fixture(outer_changes={"main.js": b""}), "byte budget")

    def test_archive_and_both_member_size_budgets(self):
        with patch.object(candidate, "MAX_ARCHIVE_BYTES", 100):
            self.reject(fixture(), "archive exceeds")
        with patch.object(candidate, "MAX_MEMBER_BYTES", 10):
            self.reject(fixture(), "member exceeds")
        self.reject(change_fields(fixture(), compressed=candidate.MAX_MEMBER_BYTES + 1), "member exceeds")

    def test_total_uncompressed_budget(self):
        with patch.object(candidate, "MAX_TOTAL_BYTES", 100):
            self.reject(fixture(), "total uncompressed")

    def test_actual_crc_not_only_claimed_metadata(self):
        self.reject(change_fields(fixture(), crc=0), "CRC")

    def test_forged_small_size_with_correct_prefix_crc(self):
        # ZipExtFile can truncate to the declared size and accept a matching
        # prefix CRC. The independent raw-stream verifier must reject it.
        prefix = FILES["main.js"][:8]
        packed = change_fields(fixture(), size=len(prefix), crc=zlib.crc32(prefix))
        with zipfile.ZipFile(io.BytesIO(packed)) as ordinary:
            self.assertEqual(ordinary.read("main.js"), prefix)
        self.reject(packed, "Actual decompression exceeds")

    def test_truncated_deflate_is_rejected(self):
        packed = fixture()
        _local, _central, info = headers(packed, "main.js")
        self.reject(change_fields(packed, compressed=info.compress_size - 1), "truncated")

    def test_trailing_compressed_data_is_rejected(self):
        packed = fixture()
        _local, _central, info = headers(packed, "main.js")
        self.reject(change_fields(packed, compressed=info.compress_size + 1), "trailing")

    def test_local_filename_mismatch_is_rejected(self):
        packed = bytearray(fixture())
        local, _central, _info = headers(packed, "main.js")
        packed[local + 30:local + 37] = b"evil.js"
        self.reject(bytes(packed), "Local filename")

    def test_local_flags_mismatch_is_rejected(self):
        packed = bytearray(fixture())
        local, _central, _info = headers(packed, "main.js")
        struct.pack_into("<H", packed, local + 6, 8)
        self.reject(bytes(packed), "headers differ")

    def test_nested_bytes_and_nested_traversal_are_rejected(self):
        self.reject(fixture(outer_changes={"styles.css": b"different"}), "Embedded plugin bytes")
        self.reject(fixture(embedded=pack([*FILES.items(), ("../source/incorrect", b"unsafe")])) )

    def test_embedded_duplicate_and_symlink_are_rejected(self):
        self.reject(fixture(embedded=pack([*FILES.items(), ("main.js", b"duplicate")])) )
        self.reject(fixture(embedded=pack(FILES.items(), modes={"main.js": stat.S_IFLNK | 0o777})), "regular")

    def test_extraction_is_fresh_only_and_validates_before_any_write(self):
        directory = Path(tempfile.mkdtemp(prefix="candidate-archive-test-", dir=SCRIPT_ROOT)).resolve()
        self.assertEqual(directory.parent, SCRIPT_ROOT)
        try:
            archive, destination = directory / "source.zip", directory / "candidate-assets"
            packed = fixture()
            archive.write_bytes(packed)
            candidate.extract_verified(archive, destination, TAG, digest(packed))
            self.assertEqual((destination / "main.js").read_bytes(), FILES["main.js"])
            (destination / "sentinel").write_text("preserve", encoding="utf8")
            with self.assertRaises(candidate.ArchiveRejected):
                candidate.extract_verified(archive, destination, TAG, digest(packed))
            self.assertEqual((destination / "sentinel").read_text(encoding="utf8"), "preserve")
            invalid = fixture(extras=[("../source/incorrect", b"unsafe")])
            archive.write_bytes(invalid)
            rejected_target = directory / "rejected-assets"
            with self.assertRaises(candidate.ArchiveRejected):
                candidate.extract_verified(archive, rejected_target, TAG, digest(invalid))
            self.assertFalse(rejected_target.exists())
        finally:
            # Only the verified, generated test directory is eligible for cleanup.
            self.assertEqual(directory.resolve().parent, SCRIPT_ROOT)
            self.assertTrue(directory.name.startswith("candidate-archive-test-"))
            shutil.rmtree(directory)


if __name__ == "__main__":
    unittest.main()
