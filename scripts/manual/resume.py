import hashlib,pathlib,sys
state,id,report=sys.argv[1:4]; p=pathlib.Path(report)
if not p.exists(): sys.exit(1)
data=p.read_bytes(); digest=hashlib.sha256(data).hexdigest()
if ('TASK-DONE '+id) not in data.decode().splitlines(): sys.exit(1)
line=id+'\t'+digest
if '--record' in sys.argv:
    with open(state,'a') as f: f.write(line+'\n')
else: sys.exit(0 if line in pathlib.Path(state).read_text().splitlines() else 1)
