"""Allowlisted, transient activity metadata. Never an authority or transcript store."""
from datetime import datetime, timezone
import re
import unicodedata

IDENTITY = re.compile(r'^[A-Za-z0-9_-]{1,160}$')
WORK = frozenset(('received', 'executing', 'pending_approval', 'completed', 'canceled', 'uncertain'))


def stamp(value):
    if not isinstance(value, str) or len(value) > 40:
        raise ValueError('Invalid presentation timestamp')
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('Presentation time needs an offset')
    return result.timestamp()


def text(value):
    if not isinstance(value, str) or not 0 < len(value) <= 160 or len(value.encode('utf-8')) > 640:
        raise ValueError('Invalid presentation summary')
    if any(unicodedata.category(c) in ('Cc','Cs') for c in value):
        raise ValueError('Invalid presentation summary')
    return value


def identity(value):
    if not isinstance(value, str) or not IDENTITY.fullmatch(value):
        raise ValueError('Invalid presentation identity')
    return value


def sequence(value):
    if type(value) is not int or not 0 <= value <= 9007199254740991:
        raise ValueError('Invalid presentation sequence')
    return value


def activity(value):
    if not isinstance(value, dict) or value.get('version') != 1 or type(value.get('version')) is not int:
        raise ValueError('Unsupported presentation version')
    if value.get('delivery') not in ('pending', 'acknowledged') or value.get('work') not in WORK:
        raise ValueError('Invalid presentation state')
    entries = value.get('entries')
    if not isinstance(entries, list) or len(entries) > 20:
        raise ValueError('Presentation capacity exceeded')
    result = {'version':1, 'sequence':sequence(value.get('sequence')),
              'delivery':value['delivery'], 'work':value['work'], 'entries':[]}
    if 'expiresAt' in value:
        stamp(value['expiresAt'])
        result['expiresAt'] = value['expiresAt']
    if 'currentSummary' in value:
        result['currentSummary'] = text(value['currentSummary'])
    previous = -1
    for entry in entries:
        if not isinstance(entry, dict) or entry.get('kind') not in ('status', 'approval_needed', 'outcome'):
            raise ValueError('Invalid presentation entry')
        item = {'activityId':identity(entry.get('activityId')), 'sequence':sequence(entry.get('sequence')), 'kind':entry['kind']}
        if item['sequence'] <= previous or item['sequence'] > result['sequence']:
            raise ValueError('Invalid presentation ordering')
        previous = item['sequence']
        if 'summary' in entry:
            item['summary'] = text(entry['summary'])
        if 'expiresAt' in entry:
            stamp(entry['expiresAt'])
            item['expiresAt'] = entry['expiresAt']
        result['entries'].append(item)
    if 'outcome' in value:
        outcome = value['outcome']
        if not isinstance(outcome, dict) or outcome.get('status') not in ('completed', 'canceled', 'uncertain') or outcome.get('verification') not in ('agent_observed', 'not_verified', 'unknown'):
            raise ValueError('Invalid outcome')
        if outcome['status'] != result['work']:
            raise ValueError('Outcome must describe terminal work')
        item = {'outcomeId':identity(outcome.get('outcomeId')), 'status':outcome['status'], 'verification':outcome['verification']}
        if 'evidenceKind' in outcome:
            if outcome['evidenceKind'] not in ('ui_observation', 'test_result', 'artifact'):
                raise ValueError('Invalid outcome evidence')
            item['evidenceKind'] = outcome['evidenceKind']
        if 'summary' in outcome:
            item['summary'] = text(outcome['summary'])
        if 'expiresAt' in outcome:
            stamp(outcome['expiresAt'])
            item['expiresAt'] = outcome['expiresAt']
        result['outcome'] = item
    return result


def label(value):
    if not value:
        return ''
    if value.get('_readiness') == 'unresolved_effect':
        return 'Outcome unresolved'
    if value.get('_readiness') == 'native_approval':
        return 'Native approval needed'
    if value['work'] == 'uncertain' or value.get('outcome', {}).get('verification') == 'unknown':
        return 'Outcome unresolved'
    if value['work'] == 'pending_approval':
        return 'Native approval needed'
    if value['work'] in ('completed', 'canceled'):
        outcome = value.get('outcome', {})
        if outcome.get('verification') != 'agent_observed':
            return 'Outcome unverified'
        return 'Agent reports completed' if value['work'] == 'completed' else 'Agent reports canceled'
    if value['work'] == 'executing':
        return 'Agent working'
    return 'Received by agent' if value['delivery'] == 'acknowledged' else 'Awaiting agent receipt'
