"""Focused HTTP/process tests for the gateway-cancellation.patch deployment."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer

source = Path(os.environ.get("UAO_GATEWAY_SOURCE", Path.home() / "local-llm-gateway/gateway.py"))
spec = importlib.util.spec_from_file_location("gateway_under_test", source)
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


class CancellationTest(unittest.TestCase):
    def setUp(self):
        gateway.TOKEN = "test-token"
        gateway._JOBS.clear()
        gateway._RECENT.clear()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), gateway.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = "http://127.0.0.1:%s" % self.server.server_port

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def post(self, path, body, token="test-token"):
        req = urllib.request.Request(self.base + path, data=json.dumps(body).encode(),
                                     headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=10) as result:
                return result.status, json.load(result)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    def test_cancel_terminates_parent_and_child(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "pids"
            script = "import subprocess,os,time; p=subprocess.Popen(['sleep','30']); open(%r,'w').write(str(os.getpid())+' '+str(p.pid)); time.sleep(30)" % str(marker)
            def runner(prompt):
                result = gateway._run_process([sys.executable, "-c", script], timeout=30)
                return result.stdout, None
            gateway.BACKENDS["test"] = runner
            response = []
            worker = threading.Thread(target=lambda: response.append(self.post("/v1/chat/completions", {
                "model": "test", "request_id": "running", "messages": [{"role": "user", "content": "test"}]})))
            worker.start()
            deadline = time.monotonic() + 5
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(marker.exists())
            pids = [int(v) for v in marker.read_text().split()]
            self.assertEqual(self.post("/v1/requests/running/cancel", {})[0], 202)
            worker.join(3)
            self.assertFalse(worker.is_alive())
            self.assertEqual(response[0][0], 499)
            for pid in pids:
                stat = Path("/proc/%s/stat" % pid)
                self.assertTrue(not stat.exists() or stat.read_text().split()[2] == "Z", "process still running")
            self.assertNotIn("running", gateway._JOBS)

    def test_cancel_before_start_prevents_execution(self):
        calls = []
        gateway.BACKENDS["test"] = lambda prompt: (calls.append(prompt) or "ok", None)
        self.post("/v1/requests/early/cancel", {})
        code, _ = self.post("/v1/chat/completions", {"model": "test", "request_id": "early", "messages": [{"role": "user", "content": "test"}]})
        self.assertEqual(code, 409)
        self.assertEqual(calls, [])

    def test_cancel_requires_authentication(self):
        self.assertEqual(self.post("/v1/requests/private/cancel", {}, "wrong")[0], 401)
        self.assertNotIn("private", gateway._RECENT)

    def test_normal_completion_and_duplicate_id(self):
        gateway.BACKENDS["test"] = lambda prompt: (gateway._run_process([sys.executable, "-c", "print('ok')"], timeout=5).stdout, None)
        body = {"model": "test", "request_id": "normal", "messages": [{"role": "user", "content": "hello"}]}
        code, result = self.post("/v1/chat/completions", body)
        self.assertEqual(code, 200)
        self.assertEqual(result["choices"][0]["message"]["content"].strip(), "ok")
        self.assertEqual(self.post("/v1/chat/completions", body)[0], 409)


if __name__ == "__main__":
    unittest.main()
