"""Read the append-only shared slot journal without reviving retired requests."""
import json
import re
import sys
from pathlib import Path

EVENT = re.compile(r'^(\S+) (\S+) (KOLEJKA WYCOFANA|WYCOFANA|KOLEJKA|START|SLOT ZWOLNIONY|KONIEC|INFO)\b(.*)$')
# Only a declaration at a clause boundary counts, not "waiting for SLOT ZWOLNIONY".
INFO_RELEASE = re.compile(
    r'(?:^|[—;.(]\s*)(?:finalny\s+)?slot\s+(?:jest\s+|został\s+)?'
    r'zwolniony(?=\s|\d|[,.;]|$)', re.IGNORECASE)


def read_queue(lines):
    pending = {}
    owner = None
    for position, line in enumerate(lines):
        match = EVENT.match(line.strip())
        if not match:
            continue
        project, session, event, detail = match.groups()
        if project == 'main':
            continue
        identity = (project, session)
        if event == 'KOLEJKA':
            # A new request replaces the same session's older place in the queue.
            pending[identity] = position
        elif event == 'START':
            pending.pop(identity, None)
            owner = identity
        elif event in ('KOLEJKA WYCOFANA', 'WYCOFANA', 'SLOT ZWOLNIONY', 'KONIEC') or (
                event == 'INFO' and INFO_RELEASE.search(detail)):
            pending.pop(identity, None)
            if event not in ('KOLEJKA WYCOFANA', 'WYCOFANA') and owner == identity:
                owner = None
    queue = sorted(pending, key=pending.get)
    return owner, queue


def main():
    filename, project, session, action = sys.argv[1:]
    owner, queue = read_queue(Path(filename).read_text().splitlines())
    identity = (project, session)
    if action == 'queued':
        return 0 if identity in queue else 1
    if action == 'ready':
        if identity not in queue:
            return 2  # Withdrawn or consumed externally: stop, do not silently requeue.
        return 0 if owner is None and queue[0] == identity else 1
    if action == 'status':
        print(json.dumps({'owner': owner, 'queue': queue}))
        return 0
    raise ValueError('Use queued|ready|status')


if __name__ == '__main__':
    sys.exit(main())
