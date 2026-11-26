"""Self-signed TLS for the WebXR (VR) web client.

WebXR requires a *secure context*: `navigator.xr` only exists on https://
pages (or http://localhost). The backend is plain http:// on the LAN, so a
Quest/Pico browser opening http://<lan-ip>:5123/vr/ never sees WebXR at all.

Fix: `--tls` starts uvicorn with a locally-generated self-signed cert whose
SANs cover the LAN IP, 127.0.0.1 and the machine hostname. The user imports
the .crt into the headset once (SideQuest / `adb push` + security settings)
and the origin is trusted from then on. Documented fallback without any cert
import: `adb reverse tcp:5123 tcp:5123` on a USB-connected headset, then open
http://localhost:5123/vr/ — localhost is exempt from the secure-context rule.

Reuses the cert across restarts; regenerates when it is close to expiry or
when the host set changed (LAN IP came and went), tracked via a `.hosts`
marker file next to the cert.
"""

import datetime
import ipaddress
import logging
import os
import socket

log = logging.getLogger("funsync.tls")

CERT_NAME = "funsync-vr.crt"
KEY_NAME = "funsync-vr.key"
HOSTS_NAME = "funsync-vr.hosts"
VALID_DAYS = 825  # Chromium's comfort zone for locally-installed anchors
RENEW_MARGIN_DAYS = 30


def _collect_hosts(extra_hosts=None):
    hosts = {"127.0.0.1", "localhost", "::1"}
    try:
        from services.network import get_local_ip
        ip = get_local_ip()
        if ip:
            hosts.add(ip)
    except Exception:
        pass
    try:
        hn = socket.gethostname()
        if hn:
            hosts.add(hn)
            hosts.add(hn.split(".")[0])
    except Exception:
        pass
    for h in (extra_hosts or []):
        if h:
            hosts.add(h)
    return sorted(hosts)


def _generate(cert_path, key_path, hosts):
    from cryptography import x509
    from cryptography.x509.oid import NameOID
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "FunSync Player VR"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "FunSync Player"),
    ])
    san_entries = []
    for h in hosts:
        try:
            san_entries.append(x509.IPAddress(ipaddress.ip_address(h)))
        except ValueError:
            san_entries.append(x509.DNSName(h))
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=VALID_DAYS))
        .add_extension(
            # CA:TRUE so the cert can be imported as a *trust anchor* on the
            # headset (Android/Quest security settings, SideQuest, or
            # `adb push` to the system store). Plain self-signed leaf certs
            # cannot be imported as anchors on modern Android.
            x509.BasicConstraints(ca=True, path_length=None), critical=True,
        )
        .add_extension(
            x509.KeyUsage(
                digital_signature=True, key_encipherment=True,
                key_cert_sign=True, crl_sign=True, content_commitment=False,
                data_encipherment=False, key_agreement=False,
                encipher_only=False, decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.SubjectAlternativeName(san_entries), critical=False)
        .sign(key, hashes.SHA256())
    )

    with open(key_path, "wb") as f:
        f.write(key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        ))
    with open(cert_path, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))
    # PEM mirror without header/footer noise is not needed; Quest imports
    # the .crt (PEM) directly.


def _load_cert(cert_path):
    from cryptography import x509
    with open(cert_path, "rb") as f:
        return x509.load_pem_x509_certificate(f.read())


def ensure_self_signed_cert(cert_dir, extra_hosts=None):
    """Return (cert_path, key_path), generating/renewing as needed.

    Raises OSError if cert_dir can't be written and whatever cryptography
    raises on malformed input — the caller (main.py) decides whether to
    fall back to plain HTTP or abort.
    """
    os.makedirs(cert_dir, exist_ok=True)
    cert_path = os.path.join(cert_dir, CERT_NAME)
    key_path = os.path.join(cert_dir, KEY_NAME)
    hosts_path = os.path.join(cert_dir, HOSTS_NAME)
    hosts = _collect_hosts(extra_hosts)

    need = True
    if os.path.isfile(cert_path) and os.path.isfile(key_path):
        try:
            cert = _load_cert(cert_path)
            not_after = cert.not_valid_after_utc
            fresh = not_after > datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=RENEW_MARGIN_DAYS)
            stored = ""
            if os.path.isfile(hosts_path):
                with open(hosts_path, "r", encoding="utf-8") as f:
                    stored = f.read()
            need = not fresh or stored != "\n".join(hosts)
        except Exception:
            need = True  # unreadable/corrupt cert — regenerate

    if need:
        log.info("[tls] generating self-signed cert for: %s", ", ".join(hosts))
        _generate(cert_path, key_path, hosts)
        with open(hosts_path, "w", encoding="utf-8") as f:
            f.write("\n".join(hosts))
    return cert_path, key_path
