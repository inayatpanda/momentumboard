"""Read-only UK sandbox probe using Webull's PUBLIC shared test credentials.
Never imports data into StreetSignal, places orders, or opens an account.
Run manually or via the public GitHub workflow. No secrets required.
"""
import json
import logging
import re
from datetime import datetime, timezone
from html import unescape
from importlib.metadata import version
from pathlib import Path
from urllib.request import Request, urlopen

from webull.core.client import ApiClient
from webull.data.data_client import DataClient
from webull.trade.trade_client import TradeClient

logging.disable(logging.CRITICAL)
DOCS = 'https://developer.webull-uk.com/apis/docs/sdk/'
HOST = 'uk-api.uat.webullbroker.com'
# Public keys are read at runtime, not saved in code or workflow logs.
with urlopen(Request(DOCS, headers={'User-Agent': 'StreetSignal sandbox evaluation'}), timeout=20) as response:
    html = response.read().decode()
keys = []
for row in re.findall(r'<tr\b[^>]*>(.*?)(?=<tr\b|</table>|$)', html, re.S):
    cells = [unescape(re.sub('<[^>]+>', '', cell)).strip() for cell in re.findall(r'<td\b[^>]*>(.*?)(?=<td\b|</tr>|</table>|$)', row, re.S)]
    if len(cells) == 4 and re.fullmatch('[a-f0-9]{32}', cells[2]) and re.fullmatch('[a-f0-9]{32}', cells[3]):
        keys.append((cells[2], cells[3]))
if not keys:
    raise SystemExit('No public sandbox credentials found in official UK documentation.')

report = {'testedAt': datetime.now(timezone.utc).isoformat(), 'environment': HOST,
          'sdkVersion': version('webull-openapi-python-sdk'), 'readOnly': True, 'attempts': []}
for index, (key, secret) in enumerate(keys[:3]):
    client = ApiClient(key, secret, 'uk', timeout=12, connect_timeout=5, auto_retry=False)
    client.add_endpoint('uk', HOST)
    data = DataClient(client)
    trade = TradeClient(client)
    attempt = {'publicTestAccount': index + 1, 'checks': []}
    checks = [('authentication', lambda: trade.account_v2.get_account_list()),
              ('AAPL snapshot', lambda: data.market_data.get_snapshot(['AAPL'], 'US_STOCK')),
              ('AAPL daily history', lambda: data.market_data.get_batch_history_bar(['AAPL'], 'US_STOCK', 'D', count='20'))]
    for label, call in checks:
        result = {'check': label}
        try:
            response = call()
            payload = response.json()
            result['httpStatus'] = response.status_code
            if response.status_code == 200:
                rows = payload if isinstance(payload, list) else payload.get('result', []) if isinstance(payload, dict) else []
                result['records'] = len(rows) if isinstance(rows, list) else 0
                if label == 'AAPL snapshot' and rows:
                    result['quoteTime'] = rows[0].get('last_trade_time')
                    result['hasPrice'] = float(rows[0].get('price', 0)) > 0
                if label == 'AAPL daily history' and isinstance(rows, list):
                    bars = [bar for item in rows if isinstance(item, dict) for bar in item.get('result', [])]
                    valid_bars = [b for b in bars if b.get('time') and float(b.get('close', 0)) > 0]
                    result['bars'] = len(valid_bars)
                    result['latestBarTime'] = max((str(b['time']) for b in valid_bars), default=None)
                    result['delayMinutes'] = [r.get('delay_minutes') for r in rows]
                result['passed'] = result['records'] > 0 and (label != 'AAPL snapshot' or result.get('hasPrice', False)) and (label != 'AAPL daily history' or result.get('bars', 0) >= 2)
            else:
                result['error'] = str(payload)[:240]
        except Exception as exc:
            message = str(exc)
            for public_key, public_secret in keys:
                message = message.replace(public_key, '[redacted]').replace(public_secret, '[redacted]')
            result['error'] = message[:240]
        attempt['checks'].append(result)
    report['attempts'].append(attempt)
    if all(c.get('passed') for c in attempt['checks']):
        break
report['passed'] = any(all(c.get('passed') for c in attempt['checks']) for attempt in report['attempts'])
Path('webull-sandbox-result.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))

raise SystemExit(0 if report['passed'] else 1)
