"""Missing content is a draft, not an invalid request or a usable answer key."""
from .core import Error, invalid


def blank(value):
    return value is None or isinstance(value, str) and not value.strip()


def normalize_missing_values(value):
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, list):
        return [normalize_missing_values(item) for item in value]
    if isinstance(value, dict):
        return {key: normalize_missing_values(item) for key, item in value.items()}
    return value


def missing_answer(mode, payload):
    if mode is None or payload is None or payload == {}:
        return True
    fields = {
        'choice': ('correct', 'selected', 'correctOption'),
        'true_false': ('value', 'answer'),
        'fill_blank': ('answers', 'value', 'answer'),
        'short_answer': ('text', 'value', 'answer'),
        'ordering': ('order',), 'matching': ('matches',),
    }[mode]
    if set(payload) - {*fields, 'grading'}:
        invalid('Answer fields do not match answer mode')
    values = [payload[k] for k in fields if k in payload]
    if len(values) > 1:
        invalid("Use a single answer representation")
    if not values or all(blank(v) or v == [] for v in values):
        return True
    value = values[0]
    if mode == 'matching':
        if not isinstance(value, list):
            invalid('Matches must be a list')
        for pair in value:
            if pair is None:
                continue
            if not isinstance(pair, dict) or set(pair) - {'left', 'right'}:
                invalid('Matches must contain left/right pairs')
            if any(v is not None and (not isinstance(v, int) or isinstance(v, bool)) for v in pair.values()):
                invalid('Match references must be integers')
    elif mode == 'ordering':
        if not isinstance(value, list) or any(v is not None and (not isinstance(v, int) or isinstance(v, bool)) for v in value):
            invalid('Order must contain integer references')
    elif mode == 'true_false':
        if not isinstance(value, bool):
            invalid('A boolean answer is required')
    elif mode == 'short_answer':
        if not isinstance(value, str):
            invalid('A textual answer is required')
    else:
        entries = value if isinstance(value, list) else [value]
        for entry in entries:
            texts = entry if isinstance(entry, list) and mode == 'fill_blank' else [entry]
            if any(v is not None and not isinstance(v, str) for v in texts):
                invalid('Answer entries must be text')
    if isinstance(value, list):
        return any(blank(v) or v == [] or isinstance(v, list) and any(blank(x) for x in v)
                   or isinstance(v, dict) and any(blank(v.get(k)) for k in ('left', 'right')) for v in value)

    return False


def require_complete(q):
    missing = q.get('missing_fields', q.get('missingFields', []))
    if missing:
        raise Error(409, 'QUESTION_INCOMPLETE', 'Complete the missing question fields before continuing', {'missingFields': missing})
