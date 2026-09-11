"""Local SMTP fixture for notification delivery tests."""

from __future__ import annotations

import socket
import threading
from dataclasses import dataclass, field


@dataclass
class MemorySmtpServer:
    """Minimal SMTP sink that records DATA payloads."""

    host: str = "127.0.0.1"
    reject_all: bool = False
    messages: list[dict[str, str]] = field(default_factory=list)
    _sock: socket.socket | None = None
    _thread: threading.Thread | None = None
    _stop = False
    port: int = 0

    def start(self) -> MemorySmtpServer:
        self._stop = False
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind((self.host, 0))
        self._sock.listen(8)
        self._sock.settimeout(0.2)
        self.port = int(self._sock.getsockname()[1])
        self._thread = threading.Thread(target=self._serve, name="memory-smtp", daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        self._stop = True
        sock = self._sock
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass
        thread = self._thread
        if thread is not None:
            thread.join(timeout=2.0)

    def _serve(self) -> None:
        assert self._sock is not None
        while not self._stop:
            try:
                conn, _addr = self._sock.accept()
            except TimeoutError:
                continue
            except OSError:
                if self._stop:
                    return
                continue
            try:
                self._handle(conn)
            except Exception:
                pass
            finally:
                try:
                    conn.close()
                except OSError:
                    pass

    def _handle(self, conn: socket.socket) -> None:
        conn.settimeout(2.0)
        if self.reject_all:
            conn.sendall(b"421 Service not available\r\n")
            return
        conn.sendall(b"220 memory-smtp ready\r\n")
        mail_from = ""
        rcpt: list[str] = []
        buf = b""
        data_mode = False
        data_chunks: list[bytes] = []
        while True:
            chunk = conn.recv(4096)
            if not chunk:
                return
            buf += chunk
            while True:
                if data_mode:
                    terminator = b"\r\n.\r\n"
                    idx = buf.find(terminator)
                    if idx < 0:
                        break
                    payload = buf[:idx]
                    buf = buf[idx + len(terminator) :]
                    data_chunks.append(payload)
                    self.messages.append(
                        {
                            "mail_from": mail_from,
                            "rcpt_to": ",".join(rcpt),
                            "data": b"".join(data_chunks).decode("utf-8", errors="replace"),
                        }
                    )
                    data_chunks = []
                    data_mode = False
                    conn.sendall(b"250 OK\r\n")
                    continue
                if b"\r\n" not in buf:
                    break
                line, buf = buf.split(b"\r\n", 1)
                cmd = line.decode("utf-8", errors="replace")
                upper = cmd[:4].upper()
                if upper in {"HELO", "EHLO"}:
                    conn.sendall(b"250 memory-smtp\r\n")
                elif upper == "MAIL":
                    mail_from = cmd[10:].strip() if len(cmd) > 10 else cmd
                    conn.sendall(b"250 OK\r\n")
                elif upper == "RCPT":
                    rcpt.append(cmd)
                    conn.sendall(b"250 OK\r\n")
                elif upper == "DATA":
                    data_mode = True
                    conn.sendall(b"354 End data with <CR><LF>.<CR><LF>\r\n")
                elif upper == "RSET":
                    mail_from = ""
                    rcpt = []
                    conn.sendall(b"250 OK\r\n")
                elif upper == "QUIT":
                    conn.sendall(b"221 Bye\r\n")
                    return
                elif upper == "NOOP":
                    conn.sendall(b"250 OK\r\n")
                else:
                    conn.sendall(b"250 OK\r\n")
