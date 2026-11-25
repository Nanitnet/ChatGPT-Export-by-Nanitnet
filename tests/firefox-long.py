"""Installed Firefox extension, 1,000 lazy-loaded/recycled messages, real files."""
import importlib.util
import json
import os
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path

spec = importlib.util.spec_from_file_location("firefox_e2e", Path(__file__).with_name("firefox-e2e.py"))
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
RESULTS = h.ROOT / "test-results/firefox-long"
RESULTS.mkdir(parents=True, exist_ok=True)
report = {"extensionVersion": h.MANIFEST['version'], "apiMocks": False, "fixtureMessages": 1000, "checks": []}

with tempfile.TemporaryDirectory(prefix="chatgpt-firefox-long-") as temporary:
    work = Path(temporary)
    profile = work / "profile"; profile.mkdir()
    downloads = work / "downloads"; downloads.mkdir()
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', str(work/'key.pem'), '-out', str(work/'cert.pem'), '-subj', '/CN=chatgpt.com', '-addext', 'subjectAltName=DNS:chatgpt.com'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    tls=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); tls.load_cert_chain(work/'cert.pem', work/'key.pem')
    proxy=ThreadingHTTPServer(('127.0.0.1',0), h.FixtureProxy); proxy.daemon_threads=True; proxy.tls=tls; proxy.requests=[]
    threading.Thread(target=proxy.serve_forever,daemon=True).start()
    with socket.socket() as reserve:
        reserve.bind(('127.0.0.1',0)); port=reserve.getsockname()[1]
    preferences={"marionette.port":port,"browser.shell.checkDefaultBrowser":False,"browser.startup.homepage_override.mstone":"ignore",
      "network.proxy.type":1,"network.proxy.http":"127.0.0.1","network.proxy.http_port":proxy.server_port,"network.proxy.ssl":"127.0.0.1","network.proxy.ssl_port":proxy.server_port,"network.proxy.no_proxies_on":"","network.proxy.failover_direct":False,"network.trr.mode":5,
      "browser.download.folderList":2,"browser.download.dir":str(downloads),"browser.download.useDownloadDir":True,"browser.download.always_ask_before_handling_new_types":False,"browser.download.alwaysOpenPanel":False,"browser.helperApps.neverAsk.saveToDisk":"text/markdown,application/json,application/octet-stream,text/plain"}
    (profile/'user.js').write_text('\n'.join(f'user_pref({json.dumps(key)}, {json.dumps(value)});' for key,value in preferences.items()))
    log=(RESULTS/'firefox.log').open('w')
    process=subprocess.Popen([h.BINARY,'--headless','--no-remote','--profile',str(profile),'--marionette','about:blank'],env={**os.environ,'MOZ_REMOTE_ALLOW_SYSTEM_ACCESS':'1'},stdout=log,stderr=log)
    try:
        def connect():
            try:return h.Marionette(port)
            except OSError:return None
        driver=h.wait_for(connect,'Firefox startup')
        caps=driver.command('WebDriver:NewSession',{'acceptInsecureCerts':True})
        report['firefoxVersion']=caps['capabilities']['browserVersion']
        assert driver.command('Addon:Install',{'path':str(h.ARCHIVE),'temporary':True})==h.ADDON_ID
        driver.command('WebDriver:Navigate',{'url':'https://chatgpt.com/c/large?count=1000&mode=recycle'})
        before=driver.script("return {count:document.querySelectorAll('[data-user-message-bubble],[data-assistant-markdown-root]').length,gap:document.querySelector('#scroll').scrollHeight-document.querySelector('#scroll').clientHeight-document.querySelector('#scroll').scrollTop};")
        assert before['count']<=11
        driver.context('chrome')
        def toggle():
            driver.script("""
              const {ExtensionParent}=ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
              const action=ExtensionParent.apiManager.global.browserActionFor(WebExtensionPolicy.getByID(arguments[0]).extension);
              const {CustomizableUI}=ChromeUtils.importESModule('moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs');
              CustomizableUI.addWidgetToArea(action.id,CustomizableUI.AREA_NAVBAR); action.triggerAction(window);
            """,[h.ADDON_ID])
        toggle()
        h.wait_for(lambda:driver.popup("return !!document.querySelector('[data-format=json]');"),'popup')
        h.wait_for(lambda:driver.popup("return document.querySelector('#panel').dataset.state==='idle'&&document.querySelector('#panel').dataset.mode==='api';"),'mode initialization')
        driver.popup("document.querySelector('#settings-toggle').click();const mode=document.querySelector('#mode');mode.value='scroll';mode.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#settings-toggle').click();return true;")
        h.wait_for(lambda:driver.popup("return document.querySelector('#panel').dataset.state==='idle'&&document.querySelector('#panel').dataset.mode==='scroll';"),'scroll mode')
        driver.popup("document.querySelector('[data-format=json]').click();return true;")
        h.wait_for(lambda:driver.popup("return !document.querySelector('#cancel').hidden;"),'collection begins')
        toggle();time.sleep(2);toggle()
        h.wait_for(lambda:driver.popup("return !!document.querySelector('[data-format=json]');"),'popup reopens')
        report['checks'].append('closed and reopened popup while collection continues')
        logged=[-1]
        def ready():
            state=driver.popup("return {text:document.querySelector('#status').textContent,error:document.querySelector('#status').dataset.error,ready:document.querySelector('#cancel').hidden&&!document.querySelector('[data-format=json]').disabled};")
            if state['error']=='true':raise AssertionError(state['text'])
            import re
            found=re.search(r'Собрано: (\d+)',state['text'])
            if found and int(found[1])//100!=logged[0]:
                logged[0]=int(found[1])//100;print('Firefox:',state['text'],flush=True)
            return state['ready'] and '1000' in state['text']
        started=time.monotonic()
        h.wait_for(ready,'1,000-message collection',timeout=240)
        for fmt,suffix in [('json','.json'),('markdown','.md')]:
            previous=set(downloads.iterdir())
            driver.popup(f"document.querySelector('[data-format={fmt}]').click();return true;")
            def received():
                files=[file for file in downloads.iterdir() if file not in previous and file.suffix==suffix and file.stat().st_size]
                return files[0] if files else None
            artifact=h.wait_for(received,fmt+' download')
            content=artifact.read_text()
            shutil.copyfile(artifact,RESULTS/('large'+suffix))
            if fmt=='json':
                data=json.loads(content)
                assert data['capture']['completeness']=='complete'
                assert data['capture']['missingBlocks']==0
                assert len(data['messages'])==1000
                for index,message in enumerate(data['messages']):
                    assert message['role']==('assistant' if index%2 else 'user')
                    expected='Повторяющийся вопрос' if index%20==0 else (f'Сообщение {index:04d}: '+'длинная проверочная переписка '*12).strip()
                    expected_markdown=expected
                    if index%10==1:
                        code=f'const messageIndex = {index};\n\nconsole.log(messageIndex);'
                        expected+='\n\n'+code
                        expected_markdown+='\n\n```js\n'+code+'\n```'
                    assert message['text']==expected, f'Incorrect or truncated body: {index}'
                    assert message['markdown']==expected_markdown, f'Incorrect Markdown body: {index}'
                report['capture']=data['capture']
            else:
                assert content.count('\n## Вы\n')==500
                assert content.count('\n## ChatGPT\n')==500
                for index in range(1000):
                    if index%20!=0:assert f'Сообщение {index:04d}:' in content
                assert content.count('Повторяющийся вопрос')==50
            report['checks'].append(f'{fmt}: real download; all 1,000 messages, exact order, repeated text, 100 code blocks')
            print(f'PASS Firefox installed extension: {fmt}, 1000/1000 messages, {len(content.encode())} bytes',flush=True)
        toggle();driver.context('content')
        stats=driver.script("return {...window.__fixtureStats,bottomGap:document.querySelector('#scroll').scrollHeight-document.querySelector('#scroll').clientHeight-document.querySelector('#scroll').scrollTop};")
        assert stats['maxHydrated']<=11 and stats['paginationLoads']==8 and stats['bottomGap']<2
        report['fixtureStats']=stats
        report['seconds']=time.monotonic()-started
        report['checks'].append('8 delayed history pages; at most 11 messages in DOM; original scroll position restored')
        report['passed']=True
        print('ALL NATIVE LARGE-CHAT FIREFOX CHECKS PASSED',flush=True)
    finally:
        (RESULTS/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
        process.terminate()
        try:process.wait(timeout=10)
        except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
        log.close();proxy.shutdown();proxy.server_close()
