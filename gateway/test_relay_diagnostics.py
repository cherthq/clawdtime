import asyncio
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import ssl
import tempfile
import unittest
from unittest.mock import patch,AsyncMock

from aiohttp import ClientSession, ClientConnectorCertificateError, TCPConnector, web
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from relay import ReconnectLog, trusted_tls_context
from service import Gateway


class DiagnosticTests(unittest.TestCase):
    def test_reconnect_logs_are_sanitized_and_rate_limited(self):
        class HandshakeFailure(Exception):
            status = 401
        now = [0.0]
        diagnostics = ReconnectLog(clock=lambda: now[0])
        error = HandshakeFailure('wss://secret-user:secret-token@private-host body=private-message')
        with self.assertLogs('clawdtime.gateway', level='WARNING') as logs:
            diagnostics.failure(error)
            for _ in range(20): diagnostics.failure(error)
            now[0] = 30.0
            diagnostics.failure(error)
        self.assertEqual(len(logs.output), 2)
        self.assertIn('exception=HandshakeFailure http_status=401 suppressed=0', logs.output[0])
        self.assertIn('suppressed=20', logs.output[1])
        self.assertNotIn('secret', ''.join(logs.output))
        self.assertNotIn('private', ''.join(logs.output))
        self.assertNotIn('wss:', ''.join(logs.output))

    def test_tls_context_keeps_verification_with_missing_system_ca_paths(self):
        with patch.dict(os.environ, {'SSL_CERT_FILE': '/nonexistent-ca-file', 'SSL_CERT_DIR': '/nonexistent-ca-dir'}):
            context = trusted_tls_context()
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertGreater(context.cert_store_stats()['x509_ca'], 0)


class TLSVerificationTests(unittest.IsolatedAsyncioTestCase):
    async def test_helper_failure_log_never_contains_exception_or_request(self):
        with tempfile.TemporaryDirectory() as folder:
            gateway=Gateway({'DEVICE_GATEWAY_DATABASE_PATH':str(Path(folder)/'gateway.sqlite')},devices={})
            gateway._helper=AsyncMock(side_effect=TimeoutError('secret-token private-screen-text http://private-host'))
            try:
                with self.assertLogs(level='WARNING') as logs:
                    with self.assertRaises(TimeoutError): await gateway.helper({'private':'body'},'GET','/secret-token/frame',frame=True)
                self.assertIn('operation=frame error=timeout status=0',logs.output[0])
                self.assertNotIn('secret',''.join(logs.output))
                self.assertNotIn('private',''.join(logs.output))
            finally: gateway.db.close()

    async def test_untrusted_local_certificate_is_still_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
            name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'localhost')])
            now = datetime.now(timezone.utc)
            cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
                .public_key(private_key.public_key()).serial_number(x509.random_serial_number())
                .not_valid_before(now - timedelta(minutes=1)).not_valid_after(now + timedelta(hours=1))
                .add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost')]), critical=False)
                .sign(private_key, hashes.SHA256()))
            keyfile, certfile = Path(folder) / 'key.pem', Path(folder) / 'cert.pem'
            keyfile.write_bytes(private_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
            certfile.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
            server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);server_context.load_cert_chain(certfile,keyfile)
            app = web.Application()
            async def health(_): return web.json_response({'fixture':True})
            app.router.add_get('/health',health)
            runner = web.AppRunner(app);await runner.setup()
            site = web.TCPSite(runner,'127.0.0.1',0,ssl_context=server_context);await site.start()
            port = site._server.sockets[0].getsockname()[1]
            loop=asyncio.get_running_loop();previous_handler=loop.get_exception_handler()
            def expected_reset(event_loop, context):
                if isinstance(context.get('exception'), ConnectionResetError):return
                if previous_handler:previous_handler(event_loop, context)
                else:event_loop.default_exception_handler(context)
            loop.set_exception_handler(expected_reset)
            try:
                async with ClientSession(connector=TCPConnector(ssl=trusted_tls_context())) as client:
                    with self.assertRaises(ClientConnectorCertificateError):
                        await client.get(f'https://localhost:{port}/health')
                await asyncio.sleep(0.01)  # allow expected server-side TLS rejection cleanup
            finally:
                await runner.cleanup()
                loop.set_exception_handler(previous_handler)


if __name__ == '__main__': unittest.main()
