"""Small deterministic media policy; no network or audio dependencies."""
from datetime import datetime, timezone
import re


def capture_allowed(policy, now=None):
    now = now or datetime.now(timezone.utc)
    try:
        expiry = datetime.fromisoformat(policy['expiresAt'].replace('Z', '+00:00'))
        return policy['state'] == 'listening' and bool(policy['callId']) and now < expiry
    except (ValueError, TypeError, KeyError):
        return False


def call_only_allowed(policy, now=None):
    return (policy.get('callOnly') is True and policy.get('state') == 'paused'
            and capture_allowed({**policy, 'state': 'listening'}, now))


def final_transcript(message):
    if message.get('type') != 'Results' or message.get('is_final') is not True:
        return None
    try:
        text = message['channel']['alternatives'][0]['transcript'].strip()
        return text if 0 < len(text) <= 8000 else None
    except (IndexError, KeyError, TypeError, AttributeError):
        return None


def pause_requested(text):
    return bool(re.fullmatch(r'hey clawdtime[,!:]?\s+(?:pause|stop) (?:notes|recording|listening|sharing)[.!]?', text, re.I))


def validate_session_id(value):
    return isinstance(value, str) and bool(re.fullmatch(r'ct_[a-f0-9]{40}', value))
