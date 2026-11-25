"""Native Firefox integration test: installed ZIP, real action popup and downloads.

Uses Firefox's built-in Marionette driver and Python's standard library. Browser
API calls are never mocked. All web requests go to a local HTTPS fixture proxy;
no account, real conversations, external test website or network login is used.
"""
import base64
import json
import os
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BINARY = os.environ.get("FIREFOX_BINARY") or shutil.which("firefox") or "firefox"
ARCHIVE = ROOT / "dist/chatgpt-local-export-firefox.zip"
RESULTS = ROOT / "test-results/firefox-native"
RESULTS.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(ARCHIVE) as bundle:
    MANIFEST = json.loads(bundle.read("manifest.json"))
ADDON_ID = MANIFEST["browser_specific_settings"]["gecko"]["id"]


class FixtureProxy(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.send_response(204)
        self.end_headers()

    def do_CONNECT(self):
        # This proxy intentionally cannot forward traffic to the internet.
        if self.path != "chatgpt.com:443":
            self.send_error(403)
            return
        self.send_response(200, "Connection Established")
        self.end_headers()
        try:
            with self.server.tls.wrap_socket(self.connection, server_side=True) as secure:
                incoming = secure.makefile("rb")
                request = incoming.readline().decode("ascii").split()
                if len(request) != 3:
                    return
                while incoming.readline() not in (b"\r\n", b"\n", b""):
                    pass
                path = request[1]
                self.server.requests.append(path)
                fixture = "fixture-large.html" if path.startswith('/c/large') else {"/c/modern": "fixture-modern.html", "/c/octane": "fixture-octane.html"}.get(path, "fixture.html")
                body = (ROOT / "tests" / fixture).read_bytes()
                headers = (
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n"
                    "Content-Security-Policy: default-src 'none'; script-src 'nonce-fixture-only'; style-src 'unsafe-inline'\r\n"
                    f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n"
                )
                secure.sendall(headers.encode() + body)
        except (OSError, ssl.SSLError):
            pass


class Marionette:
    def __init__(self, port):
        self.socket = socket.create_connection(("127.0.0.1", port), timeout=.3)
        self.socket.settimeout(20)
        self.stream = self.socket.makefile("rb")
        self.sequence = 0
        assert self.receive()["marionetteProtocol"] == 3

    def receive(self):
        prefix = bytearray()
        while True:
            character = self.stream.read(1)
            if not character:
                raise RuntimeError("Firefox disconnected")
            if character == b":":
                break
            prefix.extend(character)
        return json.loads(self.stream.read(int(prefix)))

    def command(self, name, params=None):
        self.sequence += 1
        data = json.dumps([0, self.sequence, name, params or {}]).encode()
        self.socket.sendall(str(len(data)).encode() + b":" + data)
        reply = self.receive()
        assert reply[0] == 1 and reply[1] == self.sequence
        if reply[2]:
            raise RuntimeError(reply[2])
        result = reply[3]
        return result["value"] if isinstance(result, dict) and "value" in result else result

    def context(self, name):
        self.command("Marionette:SetContext", {"value": name})

    def script(self, code, args=None):
        return self.command("WebDriver:ExecuteScript", {"script": code, "args": args or []})

    def popup(self, code):
        # Use the driver's real content actor in the native action popup.
        # It only inspects/clicks DOM, without replacing any extension API.
        return self.script("""
          const popup = document.querySelector('browser.webextension-popup-browser');
          if (!popup?.browsingContext?.currentWindowGlobal) throw new Error('Popup not open');
          return popup.browsingContext.currentWindowGlobal.getActor('MarionetteCommands')
            .executeScript(arguments[0], [], {timeout: 10000, newSandbox: true});
        """, [code])

    def popup_screenshot(self):
        # The popup is a separate native surface; a whole-window WebDriver
        # screenshot omits it. Capture its real remote browsing context.
        size = self.popup("return {width:document.body.clientWidth,height:document.body.scrollHeight};")
        return self.script("""
          const width=arguments[0],height=arguments[1];
          return (async () => {
            const popup=document.querySelector('browser.webextension-popup-browser');
            const snapshot=await popup.browsingContext.currentWindowGlobal.drawSnapshot(new DOMRect(0,0,width,height), 2, '#ffffff');
            const canvas=document.createElementNS('http://www.w3.org/1999/xhtml','canvas');
            canvas.width=snapshot.width;canvas.height=snapshot.height;
            canvas.getContext('2d').drawImage(snapshot,0,0);
            snapshot.close();
            return canvas.toDataURL('image/png').split(',')[1];
          })();
        """, [size['width'],size['height']])


def wait_for(check, description, timeout=15):
    deadline = time.monotonic() + timeout
    error = None
    while time.monotonic() < deadline:
        try:
            result = check()
            if result:
                return result
        except RuntimeError as caught:
            error = caught
        time.sleep(.1)
    raise AssertionError(f"Timeout: {description}; last error: {error}")


def test_fixtures():
    with tempfile.TemporaryDirectory(prefix="chatgpt-export-firefox-e2e-") as work:
        work = Path(work)
        profile = work / "profile"
        downloads = work / "downloads"
        profile.mkdir()
        downloads.mkdir()
        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
            "-keyout", str(work / "key.pem"), "-out", str(work / "cert.pem"),
            "-subj", "/CN=chatgpt.com", "-addext", "subjectAltName=DNS:chatgpt.com",
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(work / "cert.pem", work / "key.pem")
        proxy = ThreadingHTTPServer(("127.0.0.1", 0), FixtureProxy)
        proxy.daemon_threads = True
        proxy.tls = tls
        proxy.requests = []
        threading.Thread(target=proxy.serve_forever, daemon=True).start()
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        preferences = {
            "marionette.port": port,
            "browser.shell.checkDefaultBrowser": False,
            "browser.startup.homepage_override.mstone": "ignore",
            "network.proxy.type": 1,
            "network.proxy.http": "127.0.0.1",
            "network.proxy.http_port": proxy.server_port,
            "network.proxy.ssl": "127.0.0.1",
            "network.proxy.ssl_port": proxy.server_port,
            "network.proxy.no_proxies_on": "",
            "network.proxy.failover_direct": False,
            "network.trr.mode": 5,
            "browser.download.folderList": 2,
            "browser.download.dir": str(downloads),
            "browser.download.useDownloadDir": True,
            "browser.download.always_ask_before_handling_new_types": False,
            "browser.download.alwaysOpenPanel": False,
            "browser.helperApps.neverAsk.saveToDisk": "text/markdown,application/json,application/octet-stream,text/plain",
        }
        (profile / "user.js").write_text("\n".join(f"user_pref({json.dumps(key)}, {json.dumps(value)});" for key, value in preferences.items()))
        logfile = (RESULTS / "firefox.log").open("w")
        process = subprocess.Popen([
            BINARY, "--headless", "--no-remote", "--profile", str(profile), "--marionette", "about:blank",
        ], env={**os.environ, "MOZ_REMOTE_ALLOW_SYSTEM_ACCESS": "1"}, stdout=logfile, stderr=logfile)
        report = {"extensionVersion": MANIFEST["version"], "addonId": ADDON_ID, "apiMocks": False, "network": "local fixture proxy only", "checks": []}
        try:
            def connect():
                try:
                    return Marionette(port)
                except OSError:
                    if process.poll() is not None:
                        raise RuntimeError("Firefox exited before Marionette started")
                    return None
            driver = wait_for(connect, "Firefox startup")
            # Marionette takes negotiated capabilities directly (unlike geckodriver's
            # HTTP /session endpoint, which takes an alwaysMatch envelope).
            capabilities = driver.command("WebDriver:NewSession", {"acceptInsecureCerts": True})
            assert capabilities["capabilities"]["acceptInsecureCerts"] is True
            report["firefoxVersion"] = capabilities["capabilities"]["browserVersion"]
            assert driver.command("Addon:Install", {"path": str(ARCHIVE), "temporary": True}) == ADDON_ID
            print(f"PASS: actual Firefox {report['firefoxVersion']} installs ZIP {MANIFEST['version']}", flush=True)
            report["checks"].append("native ZIP installation")

            for layout, expected_count in (("octane", 2), ("modern", 6), ("legacy", 2)):
                driver.context("content")
                driver.command("WebDriver:Navigate", {"url": f"https://chatgpt.com/c/{layout}"})
                before_html = driver.script("return document.documentElement.outerHTML;")
                request_count = len(proxy.requests)
                driver.context("chrome")
                driver.script("""
                  const {ExtensionParent} = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
                  const extension = WebExtensionPolicy.getByID(arguments[0]).extension;
                  const action = ExtensionParent.apiManager.global.browserActionFor(extension);
                  const {CustomizableUI} = ChromeUtils.importESModule('moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs');
                  CustomizableUI.addWidgetToArea(action.id, CustomizableUI.AREA_NAVBAR);
                  action.triggerAction(window);
                """, [ADDON_ID])
                wait_for(lambda: driver.popup("return !!document.querySelector('[data-format=json]');"), "native action popup")
                wait_for(lambda: driver.popup("return document.querySelector('#panel').dataset.state==='idle'&&document.querySelector('#panel').dataset.mode==='api';"), "mode initialization")
                if layout == "legacy":
                    for theme in ("dark", "light"):
                        driver.popup("document.querySelector('#settings-toggle').click();return true;")
                        driver.popup(f"const theme=document.querySelector('#theme');theme.value='{theme}';theme.dispatchEvent(new Event('change',{{bubbles:true}}));return true;")
                        assert driver.popup("return !document.querySelector('#settings-view').hidden && document.querySelector('#settings-icon').hasAttribute('hidden') && !document.querySelector('#back-icon').hasAttribute('hidden');")
                        wait_for(lambda: driver.popup("return document.fonts.status==='loaded';"), "bundled Inter fonts")
                        driver.popup("document.querySelector('#settings-toggle').click();return true;")
                        metrics = driver.popup("""
                          const panel=document.querySelector('#panel'),button=document.querySelector('[data-format=markdown]');
                          return {theme:document.documentElement.dataset.theme,brand:document.querySelector('.brand').textContent.trim(),
                            width:document.body.clientWidth,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,
                            background:getComputedStyle(document.documentElement).backgroundColor,color:getComputedStyle(button).color,
                            settingsHidden:document.querySelector('#settings-view').hidden,diagnosticsHidden:document.querySelector('#diagnostic-panel').hidden,
                            title:document.querySelector('#view-title').textContent,buttonHeight:button.getBoundingClientRect().height,
                            icon:document.querySelector('[data-format=markdown] use').getBoundingClientRect().width};
                        """)
                        assert metrics['theme']==theme and metrics['brand']=='Nanitnet' and metrics['width']==360
                        assert metrics['settingsHidden'] and metrics['diagnosticsHidden'] and not metrics['overflow']
                        assert metrics['title']=='Экспорт чата' and metrics['buttonHeight']==46 and metrics['icon']>0
                        assert metrics['background']==('rgb(12, 12, 12)' if theme=='dark' else 'rgb(255, 255, 255)')
                        assert metrics['color']==('rgb(224, 224, 224)' if theme=='dark' else 'rgb(26, 29, 30)')
                        screenshot = driver.popup_screenshot()
                        (RESULTS / f"nanitnet-{theme}-native.png").write_bytes(base64.b64decode(screenshot))
                        (RESULTS / f"nanitnet-{theme}-layout.json").write_text(json.dumps(metrics,ensure_ascii=False,indent=2)+'\n')
                    report['checks'].append('Nanitnet compact popup, both themes, bundled Inter, visible SVG icons, settings/back views and no overflow')
                    print('PASS: native Firefox UI — dark/light, Nanitnet, settings/back, fonts and icons',flush=True)
                driver.popup("document.querySelector('#settings-toggle').click();const mode=document.querySelector('#mode');mode.value='scroll';mode.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#settings-toggle').click();return true;")
                wait_for(lambda: driver.popup("return document.querySelector('#panel').dataset.state==='idle'&&document.querySelector('#panel').dataset.mode==='scroll';"), "scroll mode")

                for format_name, suffix in (("json", ".json"), ("markdown", ".md")):
                    previous = set(downloads.iterdir())
                    driver.popup(f"document.querySelector('[data-format={format_name}]').click(); return true;")
                    def downloaded():
                        files = [file for file in downloads.iterdir() if file not in previous and file.suffix == suffix and file.stat().st_size > 0]
                        return files[0] if files else None
                    try:
                        artifact = wait_for(downloaded, f"{layout} {format_name} download")
                    except AssertionError:
                        print("Popup status:", driver.popup("return document.querySelector('#status').textContent;"), flush=True)
                        raise
                    contents = artifact.read_text()
                    if suffix == ".json":
                        conversation = json.loads(contents)
                        assert len(conversation["messages"]) == expected_count
                        assert conversation["capture"]["completeness"] == "complete"
                        assert not any("NOT_A_MESSAGE" in message["text"] or "NOT_A_MESSAGE" in message["markdown"] for message in conversation["messages"])
                        if layout == "modern":
                            assert [message["role"] for message in conversation["messages"]] == ["user", "assistant", "user", "assistant", "user", "assistant"]
                            assert conversation["messages"][0]["text"] == "Повторный вопрос\nВторая строка"
                            assert "const value = 42;" in conversation["messages"][1]["markdown"]
                    else:
                        assert contents.count("\n## Вы\n") + contents.count("\n## ChatGPT\n") == expected_count
                        assert "NOT_A_MESSAGE" not in contents
                    shutil.copyfile(artifact, RESULTS / f"{layout}{suffix}")
                    print(f"PASS: {layout} — popup {format_name} button → real scripting.executeScript → browser download ({expected_count} messages)", flush=True)
                    report["checks"].append(f"{layout}: {format_name} actual download, {expected_count} messages")

                driver.popup("document.querySelector('#settings-toggle').click();document.querySelector('#diagnose').click(); return true;")
                diagnostic_text = wait_for(lambda: driver.popup("return document.querySelector('#diagnostic-output').value;"), "diagnostic summary")
                diagnostic = json.loads(diagnostic_text)
                assert diagnostic["extensionVersion"] == MANIFEST["version"]
                assert "private-" not in diagnostic_text and "Вопрос" not in diagnostic_text
                (RESULTS / f"{layout}-diagnostics.json").write_text(diagnostic_text + "\n")
                report["checks"].append(f"{layout}: diagnostic button, count-only summary")
                screenshot = driver.command("WebDriver:TakeScreenshot", {"full": False})
                (RESULTS / f"{layout}-page.png").write_bytes(base64.b64decode(screenshot))
                driver.script("""
                  const {ExtensionParent} = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
                  ExtensionParent.apiManager.global.browserActionFor(WebExtensionPolicy.getByID(arguments[0]).extension).triggerAction(window);
                """, [ADDON_ID])
                driver.context("content")
                assert driver.script("return document.documentElement.outerHTML;") == before_html
                assert len(proxy.requests) == request_count, "Exporter must not make HTTP requests"
                print(f"PASS: {layout} — diagnostics, page HTML unchanged, no web requests during export", flush=True)

            report["passed"] = True
            print("ALL NATIVE FIREFOX CHECKS PASSED", flush=True)
        finally:
            (RESULTS / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            logfile.close()
            proxy.shutdown()
            proxy.server_close()


if __name__ == "__main__":
    test_fixtures()
