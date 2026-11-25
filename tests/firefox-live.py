"""Opt-in native Firefox test on a fresh, signed-out ChatGPT session.

Sends only a fixed public test prompt. Never uses an existing browser profile.
No browser API mocks, proxy, cookie/token access, or certificate bypass.
"""
import importlib.util
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
from pathlib import Path

spec = importlib.util.spec_from_file_location("firefox_e2e", Path(__file__).with_name("firefox-e2e.py"))
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
ROOT = helpers.ROOT
RESULTS = ROOT / "test-results/firefox-live"
RESULTS.mkdir(parents=True, exist_ok=True)
OLD_ARCHIVE = ROOT / "dist/chatgpt-local-export-firefox-0.1.1.zip"
NEW_ARCHIVE = ROOT / "dist/chatgpt-local-export-firefox.zip"
PROMPT = "Reply with EXPORT_NATIVE_FIREFOX_TEST_OK followed by a JavaScript code block containing: const exportCheck = 42;"
report = {"site": "https://chatgpt.com", "profile": "fresh, signed out", "apiMocks": False, "prompt": PROMPT, "checks": []}


with tempfile.TemporaryDirectory(prefix="chatgpt-export-firefox-live-") as work:
    work = Path(work)
    profile = work / "profile"
    downloads = work / "downloads"
    profile.mkdir()
    downloads.mkdir()
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    prefs = {
        "marionette.port": port,
        "browser.shell.checkDefaultBrowser": False,
        "browser.startup.homepage_override.mstone": "ignore",
        "browser.download.folderList": 2,
        "browser.download.dir": str(downloads),
        "browser.download.useDownloadDir": True,
        "browser.download.always_ask_before_handling_new_types": False,
        "browser.download.alwaysOpenPanel": False,
        "browser.helperApps.neverAsk.saveToDisk": "text/markdown,application/json,application/octet-stream,text/plain",
    }
    (profile / "user.js").write_text("\n".join(f"user_pref({json.dumps(key)}, {json.dumps(value)});" for key, value in prefs.items()))
    logfile = (RESULTS / "firefox.log").open("w")
    process = subprocess.Popen([
        helpers.BINARY, "--headless", "--no-remote", "--profile", str(profile), "--marionette", "about:blank",
    ], env={**os.environ, "MOZ_REMOTE_ALLOW_SYSTEM_ACCESS": "1"}, stdout=logfile, stderr=logfile)
    try:
        def connect():
            try:
                return helpers.Marionette(port)
            except OSError:
                return None
        driver = helpers.wait_for(connect, "Firefox startup")
        capabilities = driver.command("WebDriver:NewSession", {"acceptInsecureCerts": False})
        assert capabilities["capabilities"]["acceptInsecureCerts"] is False
        report["firefoxVersion"] = capabilities["capabilities"]["browserVersion"]
        initial_archive = OLD_ARCHIVE if OLD_ARCHIVE.exists() else NEW_ARCHIVE
        driver.command("Addon:Install", {"path": str(initial_archive), "temporary": True})
        driver.command("WebDriver:Navigate", {"url": "https://chatgpt.com/"})
        helpers.wait_for(lambda: driver.script("return !!document.querySelector('[role=textbox],textarea');"), "live ChatGPT composer", timeout=25)
        driver.script("""
          const reject = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Reject non-essential');
          reject?.click();
        """)
        # Cookie consent can asynchronously replace the initial guest composer.
        # Type only after that replacement, then use a trusted WebDriver click.
        time.sleep(2)
        element = driver.command("WebDriver:FindElement", {"using": "css selector", "value": "[role=textbox][contenteditable=true],textarea"})
        element_id = element["element-6066-11e4-a52e-4f735466cecf"]
        driver.command("WebDriver:ElementSendKeys", {"id": element_id, "text": PROMPT})
        send = helpers.wait_for(lambda: driver.script("""
          const textbox = document.querySelector('[role=textbox][contenteditable=true],textarea');
          const scope = textbox.closest('form') || document;
          return [...scope.querySelectorAll('[data-testid="send-button"],button[aria-label="Send message"],button[aria-label="Send prompt"],button[aria-label="Send"]')]
            .find(button => !button.disabled && button.getClientRects().length > 0) || null;
        """), "enabled visible send button")
        driver.command("WebDriver:ElementClick", {"id": send["element-6066-11e4-a52e-4f735466cecf"]})
        helpers.wait_for(lambda: driver.script("""
          return [...document.querySelectorAll('[data-message-role="user"], [data-message-author-role="user"], [data-user-message-bubble]')]
            .some(node => node.textContent.includes(arguments[0]));
        """, [PROMPT]), "submitted user turn", timeout=15)
        print("LIVE: submitted fixed test prompt in a fresh signed-out ChatGPT session", flush=True)
        helpers.wait_for(lambda: driver.script("""
          const assistant = [...document.querySelectorAll('[data-conversation-transcript] [data-message-role="assistant"]')].at(-1);
          return (document.body.innerText.match(/EXPORT_NATIVE_FIREFOX_TEST_OK/g) || []).length >= 2
            && (!assistant || assistant.hasAttribute('data-message-complete'))
            && !document.querySelector('[data-testid=stop-button], [data-testid=stop-generation-button], [data-assistant-markdown-root] [aria-busy="true"]');
        """), "live ChatGPT answer", timeout=45)
        print("LIVE: ChatGPT answered the test prompt", flush=True)
        report["checks"].append("real ChatGPT test prompt and answer")
        paths = driver.script("""
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          const paths=[];
          while(walker.nextNode()) {
            if (![arguments[0],'EXPORT_NATIVE_FIREFOX_TEST_OK'].includes(walker.currentNode.nodeValue.trim()) && !walker.currentNode.nodeValue.includes('exportCheck')) continue;
            const path=[];
            for(let node=walker.currentNode.parentElement;node && path.length<14;node=node.parentElement) {
              path.push({tag:node.tagName,attributeNames:node.getAttributeNames(),class:node.className,
                testid:node.getAttribute('data-testid'),role:node.getAttribute('role'),
                semanticAttributes:Object.fromEntries([...node.attributes].filter(attr => attr.name.startsWith('data-') && /^(user|assistant|human|system|tool|ai|message|turn)$/.test(attr.value)).map(attr=>[attr.name,attr.value]))});
            }
            paths.push(path);
          }
          return paths;
        """, [PROMPT])
        (RESULTS / 'message-paths.json').write_text(json.dumps(paths, ensure_ascii=False, indent=2)+'\n')
        print('LIVE: captured message structure (test conversation only)',flush=True)
        sanitized = driver.script("""
          const root=document.querySelector('[data-assistant-markdown-root]')?.cloneNode(true);
          if(!root) return '';
          root.querySelectorAll('script,style').forEach(node=>node.remove());
          const values=new Set(['data-d-component','data-message-role','data-language','data-code-language','role','aria-label','aria-busy','dir']);
          for(const node of [root,...root.querySelectorAll('*')]) {
            for(const attr of [...node.attributes]) {
              if(attr.name==='class') {
                node.setAttribute('class',[...node.classList].filter(name=>name==='sr-only'||name.startsWith('language-')).join(' '));
              } else if(values.has(attr.name)) {
                // These are semantic or code-language labels in the test response.
              } else if(attr.name.startsWith('data-')) {
                node.setAttribute(attr.name,'');
              } else node.removeAttribute(attr.name);
            }
          }
          return root.outerHTML;
        """)
        (RESULTS / 'live-assistant-sanitized.html').write_text(sanitized+'\n')

        def open_popup():
            driver.context("chrome")
            driver.script("""
              const {ExtensionParent} = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
              const extension = WebExtensionPolicy.getByID(arguments[0]).extension;
              const action = ExtensionParent.apiManager.global.browserActionFor(extension);
              const {CustomizableUI} = ChromeUtils.importESModule('moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs');
              CustomizableUI.addWidgetToArea(action.id, CustomizableUI.AREA_NAVBAR);
              action.triggerAction(window);
            """, [helpers.ADDON_ID])
            helpers.wait_for(lambda: driver.popup("return !!document.querySelector('[data-format=json]');"), "native popup")
            if driver.popup("return !!document.querySelector('#mode');"):
                helpers.wait_for(lambda:driver.popup("return document.querySelector('#panel').dataset.state==='idle'&&document.querySelector('#panel').dataset.mode==='api';"), 'mode initialization')
                driver.popup("document.querySelector('#settings-toggle').click();const mode=document.querySelector('#mode');mode.value='scroll';mode.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#settings-toggle').click();return true;")
                helpers.wait_for(lambda:driver.popup("return document.querySelector('#panel').dataset.state==='idle'&&document.querySelector('#panel').dataset.mode==='scroll';"), 'scroll mode')

        def close_popup():
            driver.script("""
              const {ExtensionParent} = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
              ExtensionParent.apiManager.global.browserActionFor(WebExtensionPolicy.getByID(arguments[0]).extension).triggerAction(window);
            """, [helpers.ADDON_ID])

        if OLD_ARCHIVE.exists():
            open_popup()
            driver.popup("document.querySelector('[data-format=json]').click(); return true;")
            old_status = helpers.wait_for(lambda: driver.popup("const status=document.querySelector('#status'); return document.querySelector('button:disabled') ? '' : status.textContent;"), "old version export result")
            report["oldVersionStatus"] = old_status
            report["oldBugReproduced"] = "Сообщения не найдены" in old_status
            print("LIVE 0.1.1:", old_status, flush=True)
            close_popup()
            driver.command("Addon:Install", {"path": str(NEW_ARCHIVE), "temporary": True})
        open_popup()
        for format_name, suffix in (("json", ".json"), ("markdown", ".md")):
            previous = set(downloads.iterdir())
            driver.popup(f"document.querySelector('[data-format={format_name}]').click(); return true;")
            def downloaded():
                files = [file for file in downloads.iterdir() if file not in previous and file.suffix == suffix and file.stat().st_size > 0]
                return files[0] if files else None
            try:
                artifact = helpers.wait_for(downloaded, f"live {format_name} download")
            except AssertionError:
                print("LIVE new version status:", driver.popup("return document.querySelector('#status').textContent;"), flush=True)
                raise
            contents = artifact.read_text()
            shutil.copyfile(artifact, RESULTS / f"chatgpt-live{suffix}")
            if suffix == ".json":
                conversation = json.loads(contents)
                assert conversation['capture']['method']=='scroll-and-collect'
                assert conversation['capture']['completeness']=='complete'
                assert len(conversation["messages"]) == 2
                assert [message["role"] for message in conversation["messages"]] == ["user", "assistant"]
                assert conversation["messages"][0]["text"] == PROMPT
                assert "EXPORT_NATIVE_FIREFOX_TEST_OK" in conversation["messages"][1]["text"]
                assert "const exportCheck = 42;" in conversation["messages"][1]["markdown"]
                assert "```" in conversation["messages"][1]["markdown"], "Live code block must retain a Markdown fence"
                report["exportedMessages"] = len(conversation["messages"])
            else:
                expected_prompt = PROMPT.replace("_", "\\_")
                assert f"## Вы\n\n{expected_prompt}" in contents
                assert "## ChatGPT\n\nEXPORT\\_NATIVE\\_FIREFOX\\_TEST\\_OK" in contents
                assert "const exportCheck = 42;" in contents
                assert "```" in contents
            report["checks"].append(f"actual live {format_name} download, user and assistant message verified")
            print(f"PASS LIVE: {format_name} downloaded by installed extension and verified against the real test conversation", flush=True)
        driver.popup("document.querySelector('#settings-toggle').click();document.querySelector('#diagnose').click(); return true;")
        diagnostic_text = helpers.wait_for(lambda: driver.popup("return document.querySelector('#diagnostic-output').value;"), "live diagnostic summary")
        (RESULTS / "diagnostics.json").write_text(diagnostic_text + "\n")
        report["passed"] = True
        print("ALL LIVE FIREFOX CHECKS PASSED", flush=True)
    except Exception as error:
        report["error"] = str(error)
        if "driver" in locals():
            try:
                driver.context("content")
                report["visiblePageOnFailure"] = driver.script("return document.body.innerText.slice(0, 5000);")
                print("LIVE failure page:", report["visiblePageOnFailure"], flush=True)
            except Exception:
                pass
        raise
    finally:
        (RESULTS / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        logfile.close()
