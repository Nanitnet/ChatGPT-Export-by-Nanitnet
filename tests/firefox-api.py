"""Installed Firefox extension: real MAIN-world fetches, 1,000-node HTTP fixture.

This is a controlled API server, not a test against a signed-in OpenAI account.
The browser scripting/fetch/download APIs are real. Secret fixtures are never logged.
"""
import importlib.util
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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

spec = importlib.util.spec_from_file_location("firefox_e2e", Path(__file__).with_name("firefox-e2e.py"))
h = importlib.util.module_from_spec(spec); spec.loader.exec_module(h)
RESULTS = h.ROOT / 'test-results/firefox-api'; RESULTS.mkdir(parents=True, exist_ok=True)
CHAT_ID = '11111111-1111-4111-8111-111111111111'
TOKEN = 'NATIVE_API_SECRET_MUST_NOT_LEAK'
ACCOUNT = 'NATIVE_ACCOUNT_MUST_NOT_LEAK'


def fixture():
    mapping = {'root': {'parent': None, 'message': None},
        'profile': {'parent': 'root', 'message': {'author': {'role': 'user'}, 'content': {'content_type': 'user_editable_context', 'user_profile': TOKEN, 'user_instructions': ACCOUNT}}},
        'memory': {'parent': 'profile', 'message': {'author': {'role': 'assistant'}, 'content': {'content_type': 'model_editable_context', 'model_set_context': TOKEN}}}}
    for index in range(1000):
        text = 'Повторный вопрос' if index % 20 == 0 else f'Сообщение {index}\n\n```js\nconst index = {index};\n```'
        parent = f'n{index-1}' if index else 'memory'
        if index % 2:
            mapping[f'thought{index}'] = {'parent': parent, 'message': {'author': {'role': 'assistant'}, 'recipient': 'all', 'channel': None,
                'content': {'content_type': 'thoughts', 'thoughts': [{'summary': 'PRIVATE_THINKING_MUST_NOT_EXPORT', 'content': TOKEN}]}}}
            mapping[f'recap{index}'] = {'parent': f'thought{index}', 'message': {'author': {'role': 'assistant'}, 'recipient': 'all', 'channel': None,
                'content': {'content_type': 'reasoning_recap', 'content': 'Thought for 16s'}}}
            parent = f'recap{index}'
        mapping[f'n{index}'] = {'parent': parent, 'message': {
            'author': {'role': 'assistant' if index % 2 else 'user'}, 'status': 'finished_successfully',
            'content': {'content_type': 'text', 'parts': [text]}}}
    mapping['alternate'] = {'parent': 'root', 'message': {'author': {'role': 'assistant'}, 'content': {'content_type': 'text', 'parts': ['OTHER_BRANCH_MUST_NOT_EXPORT']}}}
    return {'title': 'API — 1000 сообщений', 'current_node': 'n999', 'mapping': mapping, 'server_private': TOKEN}


class Proxy(BaseHTTPRequestHandler):
    def log_message(self, *_args): pass

    def do_CONNECT(self):
        if self.path != 'chatgpt.com:443': self.send_error(403); return
        self.send_response(200); self.end_headers()
        try:
            with self.server.tls.wrap_socket(self.connection, server_side=True) as secure:
                stream = secure.makefile('rb')
                request = stream.readline().decode().split()
                if len(request) != 3: return
                headers = {}
                while True:
                    line = stream.readline()
                    if line in (b'\r\n', b'\n', b''): break
                    name, value = line.decode().split(':', 1); headers[name.lower()] = value.strip()
                method, target, _ = request
                path = urlsplit(target).path
                scenario = self.server.scenario
                status, kind = 200, 'application/json'
                if path.startswith('/c/'):
                    body = b'<!doctype html><meta charset="utf-8"><title>API fixture</title><main><p data-message-author-role="user" data-message-id="DOM_ONLY">ONLY_DOM_FRAGMENT_MUST_NOT_EXPORT</p><div style="height:5000px"></div></main>'
                    kind = 'text/html; charset=utf-8'
                else:
                    self.server.calls.append({'method': method, 'stage': 'conversation' if path.startswith('/backend-api/') else 'session', 'authorization': 'authorization' in headers})
                    if path == '/api/auth/session':
                        data = {} if scenario in ('signedout', 'fallback') else {'accessToken': TOKEN, 'account': {'id': ACCOUNT}, 'user': {'email': 'NATIVE_EMAIL_MUST_NOT_LEAK'}}
                    elif path == '/unauth-mweb/auth/session/read-only':
                        data = {'accessToken': TOKEN, 'account': {'id': ACCOUNT}} if scenario == 'fallback' else {}
                    elif path == f'/backend-api/conversation/{CHAT_ID}':
                        if scenario == 'delayed': time.sleep(2)
                        if headers.get('authorization') != f'Bearer {TOKEN}' or headers.get('chatgpt-account-id') != ACCOUNT:
                            self.server.authorization_valid = False; status, data = 401, {}
                        elif scenario == 'forbidden': status, data = 403, {'error': TOKEN}
                        elif scenario == 'rate': status, data = 429, {'error': TOKEN}
                        else:
                            data = fixture()
                            if scenario == 'gap': del data['mapping']['n500']
                            if scenario == 'content': data['mapping']['n500']['message']['content'] = {'content_type': 'multimodal_text', 'parts': [
                                {'content_type': TOKEN, 'text': {'private': ACCOUNT}, 'asset_pointer': TOKEN, ACCOUNT: TOKEN}]}
                    else: status, data = 404, {}
                    body = json.dumps(data, ensure_ascii=False).encode()
                response = (f'HTTP/1.1 {status} Test\r\nContent-Type: {kind}\r\nContent-Length: {len(body)}\r\nConnection: close\r\n'
                    "Content-Security-Policy: default-src 'none'; script-src 'nonce-fixture-only'; style-src 'unsafe-inline'; connect-src 'self'\r\n\r\n")
                secure.sendall(response.encode() + body)
        except (OSError, ssl.SSLError): pass


report = {'extensionVersion': h.MANIFEST['version'], 'apiMocks': False, 'apiServer': 'controlled local HTTPS fixture', 'checks': []}
with tempfile.TemporaryDirectory(prefix='chatgpt-firefox-api-') as temp:
    work = Path(temp); profile = work/'profile'; profile.mkdir(); downloads = work/'downloads'; downloads.mkdir()
    subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',str(work/'key.pem'),'-out',str(work/'cert.pem'),'-subj','/CN=chatgpt.com','-addext','subjectAltName=DNS:chatgpt.com'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    tls=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); tls.load_cert_chain(work/'cert.pem',work/'key.pem')
    proxy=ThreadingHTTPServer(('127.0.0.1',0),Proxy);proxy.daemon_threads=True;proxy.tls=tls;proxy.scenario='success';proxy.calls=[];proxy.authorization_valid=True
    threading.Thread(target=proxy.serve_forever,daemon=True).start()
    with socket.socket() as reserve:reserve.bind(('127.0.0.1',0));port=reserve.getsockname()[1]
    prefs={'marionette.port':port,'browser.shell.checkDefaultBrowser':False,'browser.startup.homepage_override.mstone':'ignore',
      'network.proxy.type':1,'network.proxy.http':'127.0.0.1','network.proxy.http_port':proxy.server_port,'network.proxy.ssl':'127.0.0.1','network.proxy.ssl_port':proxy.server_port,'network.proxy.no_proxies_on':'','network.proxy.failover_direct':False,'network.trr.mode':5,
      'browser.download.folderList':2,'browser.download.dir':str(downloads),'browser.download.useDownloadDir':True,'browser.download.always_ask_before_handling_new_types':False,'browser.download.alwaysOpenPanel':False,'browser.helperApps.neverAsk.saveToDisk':'text/markdown,application/json,application/octet-stream,text/plain'}
    (profile/'user.js').write_text('\n'.join(f'user_pref({json.dumps(k)}, {json.dumps(v)});' for k,v in prefs.items()))
    log=(RESULTS/'firefox.log').open('w')
    process=subprocess.Popen([h.BINARY,'--headless','--no-remote','--profile',str(profile),'--marionette','about:blank'],env={**os.environ,'MOZ_REMOTE_ALLOW_SYSTEM_ACCESS':'1'},stdout=log,stderr=log)
    try:
        def connect():
            try:return h.Marionette(port)
            except OSError:return None
        driver=h.wait_for(connect,'Firefox startup')
        caps=driver.command('WebDriver:NewSession',{'acceptInsecureCerts':True});report['firefoxVersion']=caps['capabilities']['browserVersion']
        assert driver.command('Addon:Install',{'path':str(h.ARCHIVE),'temporary':True})==h.ADDON_ID
        def toggle():
            driver.script("""
              const {ExtensionParent}=ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
              const action=ExtensionParent.apiManager.global.browserActionFor(WebExtensionPolicy.getByID(arguments[0]).extension);
              const {CustomizableUI}=ChromeUtils.importESModule('moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs');
              CustomizableUI.addWidgetToArea(action.id,CustomizableUI.AREA_NAVBAR);action.triggerAction(window);
            """,[h.ADDON_ID])
        def open_case(scenario):
            driver.context('content');proxy.scenario=scenario;proxy.calls=[]
            driver.command('WebDriver:Navigate',{'url':f'https://chatgpt.com/c/{CHAT_ID}?case={scenario}'})
            driver.script('window.scrollTo(0,350);')
            before=driver.script('return {html:document.documentElement.outerHTML,scroll:window.scrollY};')
            driver.context('chrome');toggle()
            h.wait_for(lambda:driver.popup("return document.querySelector('#panel').dataset.state==='idle'&&document.querySelector('#panel').dataset.mode==='api';"),'API popup ready')
            assert driver.popup("return document.querySelector('#mode').value;")=='api'
            return before
        before=open_case('success')
        for fmt,suffix in [('json','.json'),('markdown','.md')]:
            old=set(downloads.iterdir());driver.popup(f"document.querySelector('[data-format={fmt}]').click();return true;")
            def downloaded():
                files=[p for p in downloads.iterdir() if p not in old and p.suffix==suffix and p.stat().st_size]
                error=driver.popup("return document.querySelector('#status').dataset.error==='true'?document.querySelector('#status').textContent:'';")
                if error:raise AssertionError(error)
                return files[0] if files else None
            file=h.wait_for(downloaded,'API '+fmt+' download');contents=file.read_text()
            assert driver.popup("return document.querySelector('#panel').dataset.state==='done' && !document.querySelector('#done-icon').hasAttribute('hidden') && document.querySelector('#spinner').hidden;")
            if fmt=='json':
                (RESULTS/'nanitnet-complete.png').write_bytes(base64.b64decode(driver.popup_screenshot()))
            for secret in [TOKEN,ACCOUNT,'NATIVE_EMAIL_MUST_NOT_LEAK','OTHER_BRANCH_MUST_NOT_EXPORT','ONLY_DOM_FRAGMENT_MUST_NOT_EXPORT','PRIVATE_THINKING_MUST_NOT_EXPORT','Thought for 16s']:assert secret not in contents
            if fmt=='json':
                data=json.loads(contents);assert len(data['messages'])==1000
                assert data['capture']['method']=='server-api' and data['capture']['parentChainVerified'] is True
                assert data['capture']['branchNodes']==2003 and data['capture']['hiddenNodes']==1002
                for index,message in enumerate(data['messages']):
                    assert message['role']==('assistant' if index%2 else 'user')
                    expected='Повторный вопрос' if index%20==0 else f'Сообщение {index}\n\n```js\nconst index = {index};\n```'
                    assert message['text']==expected and message['markdown']==expected
            else:
                assert contents.count('\n## Вы\n')==500 and contents.count('\n## ChatGPT\n')==500
                assert contents.count('Повторный вопрос')==50
            shutil.copyfile(file,RESULTS/('large'+suffix));print(f'PASS Firefox API: {fmt}, 1000/1000 exact messages, no credential leakage',flush=True)
        assert len(proxy.calls)==2 and proxy.authorization_valid
        driver.popup("document.querySelector('#settings-toggle').click();document.querySelector('#diagnose').click();return true;")
        diagnostic=h.wait_for(lambda:driver.popup("return document.querySelector('#diagnostic-output').value;"),'API diagnostics')
        assert TOKEN not in diagnostic and ACCOUNT not in diagnostic and 'Сообщение' not in diagnostic
        (RESULTS/'diagnostics.json').write_text(diagnostic+'\n')
        toggle();driver.context('content')
        after=driver.script('return {html:document.documentElement.outerHTML,scroll:window.scrollY};')
        assert before==after,'API export must not alter DOM or scroll'
        report['checks'] += ['installed ZIP, real MAIN-world injection, session GET and authenticated conversation GET', '1000 exact messages in both real downloads, 500 thoughts, 500 reasoning recaps, 2 context records; active branch and repeated text preserved', 'second format uses cached data; no extra request', 'DOM and scroll unchanged; no auth data in files or diagnostics']
        for scenario,code in [('gap','API_TREE_GAP'),('content','API_CONTENT'),('forbidden','API_FORBIDDEN'),('rate','API_RATE_LIMIT'),('signedout','API_LOGIN')]:
            open_case(scenario);old=set(downloads.iterdir());driver.popup("document.querySelector('[data-format=json]').click();return true;")
            text=h.wait_for(lambda:driver.popup("return document.querySelector('#status').dataset.error==='true'?document.querySelector('#status').textContent:'';"),scenario+' error')
            assert code in text and TOKEN not in text
            assert set(downloads.iterdir())==old
            if scenario=='signedout':assert all(call['stage']!='conversation' for call in proxy.calls)
            driver.popup("document.querySelector('#settings-toggle').click();document.querySelector('#diagnose').click();return true;")
            diagnostic=h.wait_for(lambda:driver.popup("return document.querySelector('#diagnostic-output').value;"),'failure diagnostics')
            assert TOKEN not in diagnostic and ACCOUNT not in diagnostic
            assert json.loads(diagnostic)['api']['errorCode']==code
            if scenario=='content':
                content=json.loads(diagnostic)['api']['content']
                assert [request['status'] for request in json.loads(diagnostic)['api']['requests']]==[200,200]
                assert content['parsedMessages']==500 and content['unsupported']['location']=='part'
                assert content['unsupported']['type']=='unrecognized' and content['unsupported']['otherFieldCount']==1
                assert 'Сообщение' not in diagnostic
                (RESULTS/'unsupported-diagnostics.json').write_text(diagnostic+'\n')
            toggle();report['checks'].append(scenario+': safe diagnostic, no file and no scroll fallback')
            print('PASS Firefox API failure:',code,flush=True)
        open_case('fallback');old=set(downloads.iterdir());driver.popup("document.querySelector('[data-format=json]').click();return true;")
        file=h.wait_for(lambda:next((p for p in downloads.iterdir() if p not in old and p.suffix=='.json' and p.stat().st_size),None),'session fallback download')
        assert len(json.loads(file.read_text())['messages'])==1000
        assert len(proxy.calls)==3
        report['checks'].append('current frontend read-only session fallback')
        toggle()
        open_case('delayed')
        driver.popup("document.querySelector('[data-format=json]').click();return true;")
        h.wait_for(lambda:driver.popup("return !document.querySelector('#cancel').hidden;"),'API begins')
        toggle();time.sleep(.3);toggle()
        h.wait_for(lambda:driver.popup("return document.querySelector('#panel').dataset.state==='done'&&document.querySelector('#status').textContent.replace(/\\s/g,'').includes('1000');"),'API continues after closing popup')
        old=set(downloads.iterdir());driver.popup("document.querySelector('[data-format=json]').click();return true;")
        file=h.wait_for(lambda:next((p for p in downloads.iterdir() if p not in old and p.suffix=='.json' and p.stat().st_size),None),'resumed API download')
        assert len(json.loads(file.read_text())['messages'])==1000
        assert len(proxy.calls)==2
        report['checks'].append('API request survives closing/reopening popup, ready snapshot downloads without extra requests')
        toggle();open_case('delayed');old=set(downloads.iterdir())
        driver.popup("document.querySelector('[data-format=json]').click();return true;")
        h.wait_for(lambda:driver.popup("return !document.querySelector('#cancel').hidden;"),'cancellable API begins')
        driver.popup("document.querySelector('#cancel').click();return true;")
        text=h.wait_for(lambda:driver.popup("return document.querySelector('#status').dataset.error==='true'?document.querySelector('#status').textContent:'';"),'API cancelled')
        assert 'API_CANCELLED' in text and TOKEN not in text
        assert set(downloads.iterdir())==old
        report['checks'].append('native API cancellation aborts request and does not save a partial file')
        report['passed']=True;print('ALL NATIVE FIREFOX API CHECKS PASSED',flush=True)
    finally:
        (RESULTS/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
        process.terminate()
        try:process.wait(timeout=10)
        except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
        log.close();proxy.shutdown();proxy.server_close()
