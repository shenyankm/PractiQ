"""Apply OS file/IP restrictions before parsing untrusted bytes or starting threads."""

import ctypes
import errno
import json
import os
import platform
import sys
from pathlib import Path

from .config import worker_sandbox_mode


class SandboxUnavailable(RuntimeError):
    pass


def _read_paths(executable: Path | None) -> list[Path]:
    paths = [Path(path) for path in (
        "/usr", "/bin", "/sbin", "/lib", "/lib64", "/System", "/Library/Fonts",
        "/etc/fonts", "/etc/libreoffice", "/etc/ld.so.cache", "/etc/localtime",
        "/etc/passwd", "/etc/group", "/etc/nsswitch.conf", "/etc/papersize",
    )]
    paths.extend((Path(sys.base_prefix), Path(__file__).parent, Path.home() / "Library/Fonts"))
    if executable is not None:
        engine = executable.resolve()
        paths.append(next((path for path in engine.parents if path.suffix == ".app"), engine.parent))
    return sorted({path.resolve() for path in paths if path.exists()})


def _check(result: int) -> int:
    if result < 0:
        raise OSError(ctypes.get_errno(), "Worker sandbox restriction failed")
    return result


def _linux(workspace: Path, reads: list[Path], *, office: bool) -> None:
    # These syscall numbers are shared by the supported 64-bit Linux ABIs.
    machine = platform.machine()
    if machine not in {"x86_64", "aarch64"}:
        raise SandboxUnavailable("Unsupported Linux sandbox architecture")
    libc = ctypes.CDLL(None, use_errno=True)
    abi = _check(libc.syscall(444, 0, 0, 1))
    if abi < 3:
        raise SandboxUnavailable("Landlock ABI 3 or newer is required")

    class Ruleset(ctypes.Structure):
        _fields_ = [("filesystem", ctypes.c_uint64)]

    class PathRule(ctypes.Structure):
        _pack_ = 1
        _fields_ = [("access", ctypes.c_uint64), ("parent", ctypes.c_int32)]

    handled = (1 << 15) - 1  # Includes cross-directory refer and truncate.
    ruleset = Ruleset(handled)
    descriptor = _check(libc.syscall(444, ctypes.byref(ruleset), ctypes.sizeof(ruleset), 0))
    try:
        grants = [(path, 1 | 4 | (8 if path.is_dir() else 0)) for path in reads]
        grants.extend((Path(path), 2 | 4) for path in ("/dev/null", "/dev/zero", "/dev/random", "/dev/urandom"))
        grants.append((workspace, handled & ~(1 | 64 | 2048)))
        for path, access in grants:
            parent = os.open(path, getattr(os, "O_PATH") | os.O_CLOEXEC)  # noqa: B009 - Linux-only flag is absent from macOS type stubs
            try:
                rule = PathRule(access, parent)
                _check(libc.syscall(445, descriptor, 1, ctypes.byref(rule), 0))
            finally:
                os.close(parent)
        _check(libc.prctl(38, 1, 0, 0, 0))  # PR_SET_NO_NEW_PRIVS
        _check(libc.syscall(446, descriptor, 0))
    finally:
        os.close(descriptor)

    class Filter(ctypes.Structure):
        _fields_ = [("code", ctypes.c_ushort), ("yes", ctypes.c_ubyte), ("no", ctypes.c_ubyte), ("value", ctypes.c_uint32)]

    class Program(ctypes.Structure):
        _fields_ = [("length", ctypes.c_ushort), ("filters", ctypes.POINTER(Filter))]

    arch, socket, socketpair, denied = (
        (0xC000003E, 41, 53, (42, 44, 46, 101, 298, 303, 304, 307, 310, 311, 321, 323)) if machine == "x86_64"
        else (0xC00000B7, 198, 199, (117, 203, 206, 211, 241, 264, 265, 269, 270, 271, 280, 282)))
    error, allow = 0x00050000 | errno.EPERM, 0x7FFF0000
    instructions = [(0x20, 0, 0, 4), (0x15, 1, 0, arch), (0x06, 0, 0, 0x80000000),
                    (0x20, 0, 0, 0), (0x35, 0, 1, 0x40000000), (0x06, 0, 0, error)]
    if office:
        # Landlock does not mediate access(W_OK). Deny write probes so native
        # LibreOffice selects OSL_SOCKET_PATH instead of the shared /tmp directory.
        probes = ((21, 24), (269, 32), (439, 32)) if machine == "x86_64" else ((48, 32), (439, 32))
        for number, offset in probes:
            instructions.extend(((0x15, 0, 4, number), (0x20, 0, 0, offset),
                                 (0x45, 0, 1, os.W_OK), (0x06, 0, 0, error), (0x20, 0, 0, 0)))
    # Block external Unix connections, process inspection and filesystem bypasses.
    for number in (*denied, 425, 426, 427, 438):
        instructions.extend(((0x15, 0, 1, number), (0x06, 0, 0, error)))
    # Private listening sockets/socketpairs remain available; IP/packet families fail.
    instructions.extend(((0x15, 1, 0, socket), (0x15, 0, 3, socketpair),
                         (0x20, 0, 0, 16), (0x15, 1, 0, 1), (0x06, 0, 0, error), (0x06, 0, 0, allow)))
    filters = (Filter * len(instructions))(*(Filter(*item) for item in instructions))
    program = Program(len(filters), filters)
    _check(libc.prctl(22, 2, ctypes.byref(program), 0, 0))


def _macos(workspace: Path, reads: list[Path]) -> None:
    library = ctypes.CDLL("/usr/lib/libsandbox.dylib", use_errno=True)
    # dyld opens the root directory when locating the shared cache; descendants
    # still need their own read rules and cannot inherit access from this literal.
    profile = ['(version 1)', '(deny default)', '(allow process*)', '(allow sysctl-read)',
               '(allow signal (target same-sandbox))',
               '(allow mach-lookup)', '(allow file-read-metadata)', '(allow file-read* (literal "/"))']
    for path in reads:
        profile.append(f'(allow file-read* file-map-executable (subpath {json.dumps(str(path))}))')
    profile.append(f'(allow file-read* file-write* (subpath {json.dumps(str(workspace))}))')
    profile.append(f'(allow network* (local unix-socket (subpath {json.dumps(str(workspace))})) '
                   f'(remote unix-socket (subpath {json.dumps(str(workspace))})))')
    for path in ("/dev/null", "/dev/zero", "/dev/random", "/dev/urandom"):
        profile.append(f'(allow file-read* file-write* (literal "{path}"))')
    error = ctypes.c_char_p()
    if library.sandbox_init("\n".join(profile).encode(), 0, ctypes.byref(error)) != 0:
        if error:
            library.sandbox_free_error(error)
        raise SandboxUnavailable("macOS worker sandbox could not be applied")


def enter(workspace: Path, executable: Path | None = None) -> None:
    if worker_sandbox_mode() == "disabled":
        return
    try:
        workspace = workspace.resolve(strict=True)
        reads = _read_paths(executable)
        if sys.platform == "linux":
            _linux(workspace, reads, office=executable is not None)
        elif sys.platform == "darwin":
            _macos(workspace, reads)
        else:
            raise SandboxUnavailable("No required worker sandbox for this OS")
    except (OSError, ValueError) as exc:
        raise SandboxUnavailable("Required worker sandbox is unavailable") from exc
